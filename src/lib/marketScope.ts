import { timeframeFromEventSlug } from './slugs'
import type { CoinId, ParsedMarket, TimeframeId } from './types'

/** Stable identity for a market window — used to reset spot/countdown on tab switch. */
export function marketWindowKey(market: ParsedMarket): string {
  return `${market.eventSlug}:${market.startDate?.getTime() ?? ''}:${market.endDate.getTime()}`
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
