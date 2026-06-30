import { buildEventSlugCandidates } from './slugs'
import type {
  CoinId,
  GammaEvent,
  GammaMarket,
  ParsedMarket,
  TimeframeId,
} from './types'

const GAMMA_BASE = import.meta.env.DEV ? '/api/gamma' : 'https://gamma-api.polymarket.com'

const WINDOW_MS: Record<TimeframeId, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${GAMMA_BASE}${path}`)
  if (!res.ok) throw new Error(`API error ${res.status}`)
  return res.json() as Promise<T>
}

function parseJsonArray<T>(value: string | undefined, fallback: T[]): T[] {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T[]
  } catch {
    return fallback
  }
}

/** Actual price window start — never use startDate (that's market creation time). */
function getWindowStart(
  event: GammaEvent,
  market: GammaMarket | undefined,
  timeframe: TimeframeId,
): Date | null {
  if (event.startTime) return new Date(event.startTime)
  if (market?.eventStartTime) return new Date(market.eventStartTime)

  const slugMatch = event.slug.match(/-(\d{10})$/)
  if (slugMatch) return new Date(Number(slugMatch[1]) * 1000)

  if (event.endDate) {
    return new Date(new Date(event.endDate).getTime() - WINDOW_MS[timeframe])
  }

  return null
}

function isInWindow(start: Date | null, end: Date, now: number): boolean {
  if (!start) return false
  return start.getTime() <= now && end.getTime() > now
}

function isTradeable(
  event: GammaEvent,
  market: GammaMarket | undefined,
  end: Date,
  now: number,
): boolean {
  if (event.closed || end.getTime() <= now) return false
  if (event.active === false) return false
  if (market?.acceptingOrders === false) return false
  return true
}

function parseMarket(
  event: GammaEvent,
  market: GammaMarket,
  coin: CoinId,
  timeframe: TimeframeId,
): ParsedMarket {
  const outcomes = parseJsonArray<string>(market.outcomes, ['Up', 'Down'])
  const prices = parseJsonArray<string>(market.outcomePrices, ['0.5', '0.5']).map(Number)

  const upIdx = outcomes.findIndex((o) => o.toLowerCase() === 'up')
  const downIdx = outcomes.findIndex((o) => o.toLowerCase() === 'down')
  const tokenIds = parseJsonArray<string>(market.clobTokenIds, [])
  const upTokenId = upIdx >= 0 ? (tokenIds[upIdx] ?? null) : (tokenIds[0] ?? null)
  const downTokenId = downIdx >= 0 ? (tokenIds[downIdx] ?? null) : (tokenIds[1] ?? null)
  const upPrice = upIdx >= 0 ? prices[upIdx] : prices[0]
  const downPrice = downIdx >= 0 ? prices[downIdx] : prices[1]

  const now = Date.now()
  const endDate = new Date(event.endDate)
  const windowStart = getWindowStart(event, market, timeframe)
  const inWindow = isInWindow(windowStart, endDate, now)
  const isLive = isTradeable(event, market, endDate, now)

  return {
    eventSlug: event.slug,
    title: event.title,
    coin,
    timeframe,
    upPrice,
    downPrice,
    volume: market.volumeNum ?? Number(market.volume) ?? event.volume ?? 0,
    liquidity: market.liquidityNum ?? event.liquidity ?? 0,
    endDate,
    startDate: windowStart,
    upTokenId,
    downTokenId,
    bestBidUp: market.bestBid ?? null,
    bestAskUp: market.bestAsk ?? null,
    bestBidDown: null,
    bestAskDown: null,
    priceChange1h: market.oneHourPriceChange ?? null,
    polymarketUrl: `https://polymarket.com/event/${event.slug}`,
    isLive,
    inWindow,
  }
}

function rankCandidate(a: ParsedMarket, b: ParsedMarket): number {
  if (a.inWindow !== b.inWindow) return a.inWindow ? -1 : 1
  return a.endDate.getTime() - b.endDate.getTime()
}

/** Resolve the current market by trying known slug patterns (avoids stale series lists). */
async function fetchMarketBySlugs(
  coin: CoinId,
  timeframe: TimeframeId,
): Promise<ParsedMarket | null> {
  const candidates = buildEventSlugCandidates(coin, timeframe)
  let best: ParsedMarket | null = null

  for (const slug of candidates) {
    const events = await fetchJson<GammaEvent[]>(`/events?slug=${slug}`)
    const event = events[0]
    if (!event?.markets?.[0] || event.closed) continue

    const parsed = parseMarket(event, event.markets[0], coin, timeframe)
    if (!parsed.isLive) continue

    if (parsed.inWindow) return parsed

    if (!best || rankCandidate(parsed, best) < 0) {
      best = parsed
    }
  }

  return best
}

export async function fetchCurrentMarket(
  coin: CoinId,
  timeframe: TimeframeId,
): Promise<ParsedMarket | null> {
  return fetchMarketBySlugs(coin, timeframe)
}

export function formatVolume(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`
  return `$${value.toFixed(0)}`
}

export function formatPercent(value: number): string {
  const pct = value * 100
  const rounded = Math.round(pct)
  if (Math.abs(pct - rounded) < 0.05) return `${rounded}%`
  return `${pct.toFixed(1)}%`
}

export function formatPercentInt(value: number): string {
  return `${Math.round(value * 100)}%`
}

export function formatCountdown(target: Date): string {
  const diff = target.getTime() - Date.now()
  if (diff <= 0) return 'Resolving…'

  const totalSec = Math.floor(diff / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  if (mins > 0) return `${mins}:${secs.toString().padStart(2, '0')}`
  return `0:${secs.toString().padStart(2, '0')}`
}

export function getCountdownTarget(market: ParsedMarket): { label: string; target: Date } {
  const now = Date.now()

  if (market.inWindow) {
    return { label: 'Ends in', target: market.endDate }
  }

  if (market.startDate && market.startDate.getTime() > now) {
    return { label: 'Starts in', target: market.startDate }
  }

  return { label: 'Ends in', target: market.endDate }
}
