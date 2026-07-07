import { timeframeFromEventSlug } from './slugs'
import type { CoinId, ParsedMarket, TimeframeId } from './types'

/** Stable identity for a market window — used to reset spot/countdown on tab switch. */
export function marketWindowKey(market: ParsedMarket): string {
  return `${market.eventSlug}:${market.startDate?.getTime() ?? ''}:${market.endDate.getTime()}`
}

/** Parse end timestamp (ms) from a marketWindowKey string, or null if malformed. */
export function windowEndMsFromKey(windowKey: string): number | null {
  const end = Number(windowKey.split(':').pop())
  return Number.isFinite(end) ? end : null
}

/** Parse eventSlug + window bounds from a marketWindowKey, or null if malformed. */
export function parseMarketWindowKey(windowKey: string): {
  eventSlug: string
  startMs: number
  endMs: number
} | null {
  const parts = windowKey.split(':')
  if (parts.length !== 3) return null
  const startMs = Number(parts[1])
  const endMs = Number(parts[2])
  if (!parts[0] || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  return { eventSlug: parts[0], startMs, endMs }
}

/** True when a polled market belongs to the selected coin + timeframe tab. */
export function marketMatchesScope(
  market: ParsedMarket,
  coin: CoinId,
  timeframe: TimeframeId,
): boolean {
  if (market.coin !== coin) return false
  const fromSlug = timeframeFromEventSlug(market.eventSlug)
  return fromSlug === timeframe
}

/** Tradeable window that's actually open right now — rejects ended/upcoming snapshots in cache. */
export function isCurrentWindow(market: ParsedMarket, now = Date.now()): boolean {
  if (!market.isLive || !market.startDate) return false
  const start = market.startDate.getTime()
  const end = market.endDate.getTime()
  return start <= now && end > now
}

/** Drop scope/expiry mismatches before TanStack serves cached market rows to the UI. */
export function sanitizeMarketSnapshot(
  market: ParsedMarket | null | undefined,
  coin: CoinId,
  timeframe: TimeframeId,
  now = Date.now(),
): ParsedMarket | null {
  if (!market) return null
  if (!marketMatchesScope(market, coin, timeframe)) return null
  if (!isCurrentWindow(market, now)) return null
  return market
}
