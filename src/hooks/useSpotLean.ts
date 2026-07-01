import { useChainlinkSpot } from '@/hooks/useChainlinkSpot'
import { chainlinkSocket } from '@/lib/chainlinkSocket'
import { chainlinkPair, isRollingSlug } from '@/lib/cryptoPrice'
import type { CoinId, ParsedMarket } from '@/lib/types'

export interface SpotLean {
  /** Live spot minus the window-open strike; sign tells which side is currently winning. */
  delta: number | null
  strike: number | null
  current: number | null
}

const EMPTY: SpotLean = { delta: null, strike: null, current: null }

/**
 * Per-coin live "spot lean" for the watchlist — Chainlink spot vs the window-open strike.
 * These up/down order books sit at ~50/50 while quiet, so the moving, per-coin signal is
 * the spot delta, not the odds. Reads the shared Chainlink socket (already streaming every
 * coin via a single `type:'*'` subscription), so it's one WS subscription and no HTTP.
 * Returns null until both a boundary tick (strike) and a live tick exist.
 */
export function useSpotLean(coin: CoinId, market: ParsedMarket | null): SpotLean {
  const { tick } = useChainlinkSpot(coin)
  const pair = chainlinkPair(coin)
  if (!pair || !market || !market.isLive || !market.startDate) return EMPTY

  const startMs = market.startDate.getTime()
  const rolling = isRollingSlug(market.eventSlug)
  // Rolling windows must use the Chainlink boundary tick: gamma's priceToBeat is the
  // hour anchor (4h) or null (5m/15m), not the per-slot open — falling back to it can
  // show the opposite lean vs the focused card. Non-rolling priceToBeat matches the
  // crypto-price openPrice, so it's a safe cold-load fallback there.
  const strike =
    (startMs > 0 ? chainlinkSocket.strikeAtBoundary(pair, startMs, rolling) : null) ??
    (rolling ? null : market.priceToBeat)
  const liveValue = tick && Number.isFinite(tick.value) ? tick.value : null
  const current = liveValue ?? chainlinkSocket.latestTick(pair)?.value ?? null
  const delta = strike != null && current != null ? current - strike : null
  return { delta, strike, current }
}

/**
 * Signed dollar delta with precision scaled to the delta's magnitude (leans are tiny
 * right after a boundary). Distinct on purpose from cryptoPrice's formatSpotDelta,
 * which uses per-coin precision for the focused card's spot bar.
 */
export function formatLeanDelta(delta: number): string {
  const abs = Math.abs(delta)
  const magnitude =
    abs >= 1
      ? abs.toFixed(2)
      : abs >= 0.01
        ? abs.toFixed(3)
        : abs >= 0.0001
          ? abs.toFixed(5)
          : abs > 0
            ? abs.toExponential(1)
            : '0.00'
  return `${delta >= 0 ? '+' : '−'}$${magnitude}`
}
