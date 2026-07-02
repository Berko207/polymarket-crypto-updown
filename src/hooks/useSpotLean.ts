import { useQuery } from '@tanstack/react-query'
import { useChainlinkSpot } from '@/hooks/useChainlinkSpot'
import { chainlinkSocket } from '@/lib/chainlinkSocket'
import {
  chainlinkPair,
  coinSymbol,
  fetchCryptoPrice,
  isRollingSlug,
  previousWindowParams,
} from '@/lib/cryptoPrice'
import { qk } from '@/queries/keys'
import type { CoinId, ParsedMarket } from '@/lib/types'

export interface SpotLean {
  /** Live spot minus the window-open strike; sign tells which side is currently winning. */
  delta: number | null
  strike: number | null
  current: number | null
}

const EMPTY: SpotLean = { delta: null, strike: null, current: null }

function validPrice(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Per-coin live "spot lean" for the watchlist — Chainlink spot vs the window-open strike.
 * These up/down order books sit at ~50/50 while quiet, so the moving, per-coin signal is
 * the spot delta, not the odds. Reads the shared Chainlink socket (already streaming every
 * coin via a single `type:'*'` subscription), so steady state is one WS subscription and
 * no HTTP. The one exception: a cold load mid-window on a rolling slug has no boundary
 * tick in WS history, so the prior window's close (== this window's open) is fetched once
 * rather than showing nothing until the next boundary (up to 15m/4h away).
 */
export function useSpotLean(coin: CoinId, market: ParsedMarket | null): SpotLean {
  const { tick } = useChainlinkSpot(coin)
  const pair = chainlinkPair(coin)
  const active = Boolean(pair && market && market.isLive && market.startDate)

  const startMs = active ? market!.startDate!.getTime() : 0
  const rolling = active ? isRollingSlug(market!.eventSlug) : false
  // Rolling windows must use the Chainlink boundary tick: gamma's priceToBeat is the
  // hour anchor (4h) or null (5m/15m), not the per-slot open — falling back to it can
  // show the opposite lean vs the focused card. Non-rolling priceToBeat matches the
  // crypto-price openPrice, so it's a safe cold-load fallback there.
  const boundaryStrike =
    active && startMs > 0 ? chainlinkSocket.strikeAtBoundary(pair!, startMs, rolling) : null

  // Key matches useMarketSpot's prevQuery so the focused market dedupes into one request.
  const prevWindow =
    active && rolling && boundaryStrike == null ? previousWindowParams(market!) : null
  const prevQuery = useQuery({
    queryKey: prevWindow
      ? qk.cryptoWindowPrev(
          coin,
          market!.timeframe,
          market!.eventSlug,
          prevWindow.eventStartTime,
          prevWindow.endDate,
        )
      : (['cryptoWindowPrev', 'lean-idle', coin] as const),
    queryFn: () => fetchCryptoPrice(coinSymbol(coin), prevWindow!.eventStartTime, prevWindow!.endDate),
    enabled: prevWindow != null,
    staleTime: Infinity,
    retry: 2,
    structuralSharing: false,
  })

  if (!active) return EMPTY

  const prevClose = prevWindow ? validPrice(prevQuery.data?.closePrice) : null
  const strike = boundaryStrike ?? (rolling ? prevClose : market!.priceToBeat)
  const liveValue = tick && Number.isFinite(tick.value) ? tick.value : null
  const current = liveValue ?? chainlinkSocket.latestTick(pair!)?.value ?? null
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
          : abs >= 0.000001
            ? abs.toFixed(6) // sub-cent coins (doge) lean in the 1e-5 range — keep it plain, not 9.7e-5
            : abs > 0
              ? abs.toExponential(1)
              : '0.00'
  return `${delta >= 0 ? '+' : '−'}$${magnitude}`
}
