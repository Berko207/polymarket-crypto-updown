import { fetchTradeHistory, type Position, type TradeFill } from './api'
import { coinSymbolFromTitle, marketWindowLabel } from './marketLabels'
import { timeframeFromEventSlug } from './slugs'

/** Data API hard cap — offsets past 3000 are rejected upstream. */
const MAX_OFFSET = 3_000
/** Data API max page; bigger pages also reach deeper (the cap is on offset, not depth). */
const PAGE_SIZE = 1_000
/** Matches the Data-API dust threshold used by the portfolio views. */
const DUST_SIZE = 0.01

export interface FullTradeHistory {
  fills: TradeFill[]
  /** True when the Data API's offset cap stopped pagination before the real end. */
  truncated: boolean
}

/**
 * Page through the whole filled-order ledger — 4 requests worst case (offsets
 * 0/1k/2k/3k at 1000/page), reaching the ~4,000 most recent fills the Data API
 * can serve at all.
 */
export async function fetchAllTradeHistory(
  onProgress?: (count: number) => void,
): Promise<FullTradeHistory> {
  const fills: TradeFill[] = []
  let offset: number | null = 0
  let truncated = false
  while (offset != null) {
    // Past the upstream cap every request would 400 — stop, don't loop.
    if (offset > MAX_OFFSET) {
      truncated = true
      break
    }
    const page = await fetchTradeHistory(offset, PAGE_SIZE)
    fills.push(...page.trades)
    onProgress?.(fills.length)
    if (page.capReached) truncated = true
    offset = page.nextOffset
  }
  return { fills, truncated }
}

export interface ExportFillRow {
  datetime_utc: string
  unix_seconds: number
  coin: string
  timeframe: string
  window: string
  side: 'BUY' | 'SELL'
  outcome: string
  shares: number
  price: number
  value_usd: number
  title: string
  event_slug: string
  token_id: string
  transaction_hash: string
}

function isoFromUnix(seconds: number): string {
  return seconds ? new Date(seconds * 1000).toISOString() : ''
}

function round(n: number, dp = 6): number {
  const factor = 10 ** dp
  return Math.round(n * factor) / factor
}

export function toExportRow(fill: TradeFill): ExportFillRow {
  return {
    datetime_utc: isoFromUnix(fill.timestamp),
    unix_seconds: fill.timestamp,
    coin: fill.title ? coinSymbolFromTitle(fill.title) : '',
    timeframe: timeframeFromEventSlug(fill.eventSlug) ?? '',
    window: fill.title ? marketWindowLabel(fill.title) : '',
    side: fill.side,
    outcome: fill.outcome,
    shares: fill.size,
    price: fill.price,
    value_usd: round(fill.size * fill.price),
    title: fill.title,
    event_slug: fill.eventSlug,
    token_id: fill.tokenId,
    transaction_hash: fill.transactionHash,
  }
}

export type MarketSummaryStatus = 'closed' | 'holding-or-resolved' | 'incomplete'
export type MarketResult = 'win' | 'loss' | 'breakeven' | ''

export interface MarketSummaryRow {
  coin: string
  timeframe: string
  window: string
  outcome: string
  /** closed = fully round-tripped via sells (P&L exact). holding-or-resolved = shares
   * kept past the ledger (still open, or settled at resolution — payout isn't a trade,
   * so it can't be computed here). incomplete = sold more than bought in the fetched
   * window (history gap). */
  status: MarketSummaryStatus
  result: MarketResult
  realized_pnl_usd: number | null
  realized_pnl_pct: number | null
  hold_seconds: number | null
  buy_fills: number
  bought_shares: number
  avg_buy_price: number | null
  buy_cost_usd: number
  sell_fills: number
  sold_shares: number
  avg_sell_price: number | null
  sell_proceeds_usd: number
  net_shares: number
  net_cash_flow_usd: number
  first_trade_utc: string
  first_trade_unix: number
  last_trade_utc: string
  last_trade_unix: number
  title: string
  event_slug: string
  token_id: string
}

/** One row per traded outcome token, newest activity first. */
export function buildMarketSummaries(fills: TradeFill[]): MarketSummaryRow[] {
  const byToken = new Map<string, TradeFill[]>()
  for (const f of fills) {
    const list = byToken.get(f.tokenId) ?? []
    list.push(f)
    byToken.set(f.tokenId, list)
  }

  const rows: MarketSummaryRow[] = []
  for (const [tokenId, group] of byToken) {
    const sorted = [...group].sort((a, b) => a.timestamp - b.timestamp)
    const labeled = sorted.find((f) => f.title) ?? sorted[0]

    const buys = sorted.filter((f) => f.side === 'BUY')
    const sells = sorted.filter((f) => f.side === 'SELL')
    const boughtShares = buys.reduce((sum, f) => sum + f.size, 0)
    const buyCostUsd = buys.reduce((sum, f) => sum + f.size * f.price, 0)
    const soldShares = sells.reduce((sum, f) => sum + f.size, 0)
    const sellProceedsUsd = sells.reduce((sum, f) => sum + f.size * f.price, 0)
    const netShares = boughtShares - soldShares

    let status: MarketSummaryStatus
    let result: MarketResult = ''
    let realizedPnlUsd: number | null = null
    let realizedPnlPct: number | null = null
    let holdSeconds: number | null = null

    if (Math.abs(netShares) <= DUST_SIZE) {
      status = 'closed'
      realizedPnlUsd = round(sellProceedsUsd - buyCostUsd)
      realizedPnlPct = buyCostUsd > 0 ? round((realizedPnlUsd / buyCostUsd) * 100, 2) : null
      result = Math.abs(realizedPnlUsd) < 0.005 ? 'breakeven' : realizedPnlUsd > 0 ? 'win' : 'loss'
      if (buys.length > 0 && sells.length > 0) {
        holdSeconds = sells[sells.length - 1].timestamp - buys[0].timestamp
      }
    } else if (netShares > DUST_SIZE) {
      status = 'holding-or-resolved'
    } else {
      status = 'incomplete'
    }

    rows.push({
      coin: labeled.title ? coinSymbolFromTitle(labeled.title) : '',
      timeframe: timeframeFromEventSlug(labeled.eventSlug) ?? '',
      window: labeled.title ? marketWindowLabel(labeled.title) : '',
      outcome: labeled.outcome,
      status,
      result,
      realized_pnl_usd: realizedPnlUsd,
      realized_pnl_pct: realizedPnlPct,
      hold_seconds: holdSeconds,
      buy_fills: buys.length,
      bought_shares: round(boughtShares),
      avg_buy_price: boughtShares > 0 ? round(buyCostUsd / boughtShares, 4) : null,
      buy_cost_usd: round(buyCostUsd),
      sell_fills: sells.length,
      sold_shares: round(soldShares),
      avg_sell_price: soldShares > 0 ? round(sellProceedsUsd / soldShares, 4) : null,
      sell_proceeds_usd: round(sellProceedsUsd),
      net_shares: round(netShares),
      net_cash_flow_usd: round(sellProceedsUsd - buyCostUsd),
      first_trade_utc: isoFromUnix(sorted[0].timestamp),
      first_trade_unix: sorted[0].timestamp,
      last_trade_utc: isoFromUnix(sorted[sorted.length - 1].timestamp),
      last_trade_unix: sorted[sorted.length - 1].timestamp,
      title: labeled.title,
      event_slug: labeled.eventSlug,
      token_id: tokenId,
    })
  }

  return rows.sort((a, b) => b.last_trade_unix - a.last_trade_unix)
}

export interface HistoryStats {
  total_fills: number
  markets_traded: number
  total_buy_cost_usd: number
  total_sell_proceeds_usd: number
  /** Cash out minus cash in across every fill — excludes resolution payouts. */
  net_cash_flow_usd: number
  closed_markets: number
  wins: number
  losses: number
  breakevens: number
  win_rate_pct: number | null
  closed_pnl_usd: number
  avg_closed_pnl_usd: number | null
  best_closed_pnl_usd: number | null
  worst_closed_pnl_usd: number | null
  holding_or_resolved_markets: number
  incomplete_markets: number
}

export function buildHistoryStats(
  fills: TradeFill[],
  summaries: MarketSummaryRow[],
): HistoryStats {
  const closed = summaries.filter((s) => s.status === 'closed')
  const wins = closed.filter((s) => s.result === 'win').length
  const losses = closed.filter((s) => s.result === 'loss').length
  const breakevens = closed.filter((s) => s.result === 'breakeven').length
  const decided = wins + losses
  const closedPnls = closed
    .map((s) => s.realized_pnl_usd)
    .filter((p): p is number => p != null)
  const closedPnlUsd = round(closedPnls.reduce((sum, p) => sum + p, 0))

  const totalBuyCost = summaries.reduce((sum, s) => sum + s.buy_cost_usd, 0)
  const totalSellProceeds = summaries.reduce((sum, s) => sum + s.sell_proceeds_usd, 0)

  return {
    total_fills: fills.length,
    markets_traded: summaries.length,
    total_buy_cost_usd: round(totalBuyCost),
    total_sell_proceeds_usd: round(totalSellProceeds),
    net_cash_flow_usd: round(totalSellProceeds - totalBuyCost),
    closed_markets: closed.length,
    wins,
    losses,
    breakevens,
    win_rate_pct: decided > 0 ? round((wins / decided) * 100, 2) : null,
    closed_pnl_usd: closedPnlUsd,
    avg_closed_pnl_usd: closed.length > 0 ? round(closedPnlUsd / closed.length) : null,
    best_closed_pnl_usd: closedPnls.length > 0 ? Math.max(...closedPnls) : null,
    worst_closed_pnl_usd: closedPnls.length > 0 ? Math.min(...closedPnls) : null,
    holding_or_resolved_markets: summaries.filter((s) => s.status === 'holding-or-resolved')
      .length,
    incomplete_markets: summaries.filter((s) => s.status === 'incomplete').length,
  }
}

function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** UTF-8 BOM + CRLF so Excel opens it cleanly. Column order follows the row type. */
function toCsv<T extends Record<string, unknown>>(rows: T[], columns: (keyof T & string)[]): string {
  const lines = [columns.join(',')]
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(','))
  }
  return '\uFEFF' + `${lines.join('\r\n')}\r\n`
}

const FILL_COLUMNS: (keyof ExportFillRow & string)[] = [
  'datetime_utc',
  'unix_seconds',
  'coin',
  'timeframe',
  'window',
  'side',
  'outcome',
  'shares',
  'price',
  'value_usd',
  'title',
  'event_slug',
  'token_id',
  'transaction_hash',
]

export function fillsToCsv(fills: TradeFill[]): string {
  return toCsv(
    fills.map(toExportRow) as unknown as Record<string, unknown>[],
    FILL_COLUMNS,
  )
}

const SUMMARY_COLUMNS: (keyof MarketSummaryRow & string)[] = [
  'coin',
  'timeframe',
  'window',
  'outcome',
  'status',
  'result',
  'realized_pnl_usd',
  'realized_pnl_pct',
  'hold_seconds',
  'buy_fills',
  'bought_shares',
  'avg_buy_price',
  'buy_cost_usd',
  'sell_fills',
  'sold_shares',
  'avg_sell_price',
  'sell_proceeds_usd',
  'net_shares',
  'net_cash_flow_usd',
  'first_trade_utc',
  'first_trade_unix',
  'last_trade_utc',
  'last_trade_unix',
  'title',
  'event_slug',
  'token_id',
]

export function summariesToCsv(summaries: MarketSummaryRow[]): string {
  return toCsv(summaries as unknown as Record<string, unknown>[], SUMMARY_COLUMNS)
}

export function fillsToJson(fills: TradeFill[], truncated: boolean): string {
  return JSON.stringify(
    {
      schema: 'polymarket-updown-fills/v1',
      exported_at: new Date().toISOString(),
      truncated,
      count: fills.length,
      fills: fills.map(toExportRow),
    },
    null,
    2,
  )
}

/** Everything: roll-up stats + per-market summaries + raw fills + live positions. */
export function buildExportBundle(
  fills: TradeFill[],
  truncated: boolean,
  positions: Position[] | null,
): string {
  const summaries = buildMarketSummaries(fills)
  return JSON.stringify(
    {
      schema: 'polymarket-updown-export/v1',
      exported_at: new Date().toISOString(),
      truncated,
      stats: buildHistoryStats(fills, summaries),
      market_summaries: summaries,
      fills: fills.map(toExportRow),
      // Raw Data-API positions (open + resolved) — carries avgPrice/cashPnl/redeemable,
      // which the fills ledger alone can't reconstruct. Null when the fetch failed.
      positions_snapshot: positions,
    },
    null,
    2,
  )
}

export function exportFilename(kind: string, ext: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `polymarket-updown-${kind}-${stamp}.${ext}`
}

export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
