/**
 * Client for the local bot's control server (bot/control.ts). The bot runs on
 * the operator's machine, so this only works in local dev (dashboard on
 * localhost → bot on 127.0.0.1). In production the fetch fails fast and the
 * panel shows "offline".
 */
export type BotMode = 'record' | 'dry' | 'live'

export interface BotStatus {
  mode: BotMode
  /** USDC stake per automated entry; defaults to 1 when talking to an older bot. */
  stakeUsd?: number
  /** CLOB USDC when live; optional for older bot builds. */
  usdcBalance?: number | null
  /** Optional so a bot predating the swing strategy still renders (defaults to value). */
  strategy?: 'value' | 'swing' | 'maker'
  allowLive: boolean
  halted: boolean
  connected: boolean
  scopes: string[]
  liveScopes: number
  stats: { ticks: number; predictions: number; outcomes: number; trades: number; settled: number }
  summary: { entered: number; settled: number; open: number; wins: number; staked: number; pnl: number }
  /** Entries in the rolling 24h window; optional for older bot builds. */
  dailyTrades?: number
  maxDailyTrades?: number
  /** Traded subset + full recorded universe; absent when talking to an older bot. */
  tradeTimeframes?: string[]
  availableTimeframes?: string[]
  /** Positions still being force-closed at market (strategy-switch retries). */
  pendingCloses?: number
  swingExits?: { reason: string; n: number; wins: number; pnl: number }[]
  swingTrigger?: 'edge' | 'move'
  swingSource?: 'flat' | 'regime' | 'blend'
  openPositions?: {
    coin: string
    timeframe: string
    side: 'up' | 'down'
    strategy: string
    entryPrice: number
    size: number
    mark: number | null
    unrealizedPnl: number | null
    msRemaining: number | null
  }[]
  recentClosed?: {
    mode?: string
    coin: string
    timeframe: string
    side: 'up' | 'down'
    strategy: string
    entryPrice: number
    exitPrice: number | null
    exitReason: string | null
    pnl: number
    settleT: number
    status: string
  }[]
  /** Maker-strategy live state — present only while strategy='maker'. */
  maker?: {
    fillModel: 'L1' | 'L2'
    baseSpread: number
    clipUsd: number
    maxInventory: number
    rebateRate: number
    feedConnected: boolean
    fills: number
    openQuotes: number
    inventory: { coin: string; timeframe: string; net: number; upShares: number; downShares: number }[]
    quotes: { coin: string; timeframe: string; side: 'up' | 'down'; price: number; size: number }[]
  }
}

const BASE =
  ((import.meta.env.VITE_BOT_CONTROL_URL as string | undefined) ?? 'http://127.0.0.1:8790').replace(
    /\/$/,
    '',
  )

/** Token from localStorage (operator-entered) or build-time env. */
function token(): string | null {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('bot-control-token') : null
  return stored || (import.meta.env.VITE_BOT_CONTROL_TOKEN as string | undefined) || null
}

function postHeaders(): Record<string, string> {
  const t = token()
  return { 'content-type': 'application/json', ...(t ? { 'x-bot-token': t } : {}) }
}

export async function fetchBotStatus(): Promise<BotStatus> {
  const res = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2500) })
  if (!res.ok) throw new Error(`bot control ${res.status}`)
  return (await res.json()) as BotStatus
}

async function post(path: string, body: unknown): Promise<BotStatus> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: postHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  const data = (await res.json().catch(() => ({}))) as BotStatus & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `bot control ${res.status}`)
  return data
}

export const setBotMode = (mode: BotMode): Promise<BotStatus> => post('/mode', { mode })
export const setBotHalted = (halted: boolean): Promise<BotStatus> => post('/halt', { halted })
export const setBotStake = (stakeUsd: number): Promise<BotStatus> => post('/stake', { stakeUsd })
export const setBotMaxDailyTrades = (maxDailyTrades: number): Promise<BotStatus> =>
  post('/daily-cap', { maxDailyTrades })
export const setBotStrategy = (strategy: 'value' | 'swing' | 'maker'): Promise<BotStatus> =>
  post('/strategy', { strategy })
export const setBotTradeTimeframes = (timeframes: string[]): Promise<BotStatus> =>
  post('/timeframes', { timeframes })
export interface MakerPatch {
  baseSpread?: number
  clipUsd?: number
  maxInventory?: number
  fillModel?: 'L1' | 'L2'
  rebateRate?: number
}
export const setBotMaker = (patch: MakerPatch): Promise<BotStatus> => post('/maker', patch)

/** One trade row in the history grid — mirrors the bot's TradeHistoryRow. */
export interface TradeHistoryRow {
  id: number
  windowKey: string
  coin: string
  timeframe: string
  mode: string
  strategy: string
  side: 'up' | 'down'
  entryT: number
  entryPrice: number
  size: number
  cost: number
  entryFee: number
  signalEdge: number
  regimeEntry: string | null
  status: string
  settleT: number | null
  exitPrice: number | null
  exitReason: string | null
  exitFee: number | null
  payout: number | null
  pnl: number | null
  orderId: string | null
}

export interface HistoryFilters {
  mode?: string
  strategy?: string
  coin?: string
  timeframe?: string
  status?: string
  reason?: string
  outcome?: string
  /** entry_t epoch-ms bounds (inclusive). */
  from?: number
  to?: number
  limit?: number
  offset?: number
}

export interface HistoryPage {
  rows: TradeHistoryRow[]
  total: number
  summary: { realized: number; wins: number; pnl: number; staked: number }
}

export async function fetchBotHistory(filters: HistoryFilters): Promise<HistoryPage> {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(filters)) {
    if (v != null && v !== '') q.set(k, String(v))
  }
  const res = await fetch(`${BASE}/history?${q.toString()}`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`bot history ${res.status}`)
  return (await res.json()) as HistoryPage
}
