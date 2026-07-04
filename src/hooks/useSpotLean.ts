import { useQuery } from '@tanstack/react-query'
import { useChainlinkSpot } from '@/hooks/useChainlinkSpot'
import { useNow } from '@/hooks/useNow'
import { chainlinkSocket } from '@/lib/chainlinkSocket'
import {
  chainlinkPair,
  coinSymbol,
  cryptoPriceWindowParams,
  fetchCryptoPrice,
  isRollingSlug,
  validPrice,
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

/** Give the live stream this long to deliver a fresh window's boundary tick before
 * falling back to REST — avoids a burst of fetches at every rollover. */
const STRIKE_FALLBACK_DELAY_MS = 8_000

/**
 * Per-coin live "spot lean" for the watchlist — Chainlink spot vs the window-open strike.
 * These up/down order books sit at ~50/50 while quiet, so the moving, per-coin signal is
 * the spot delta, not the odds. Reads the shared Chainlink socket (already streaming every
 * coin via a single `type:'*'` subscription). Rolling windows need the per-slot open:
 * gamma's priceToBeat is the hour anchor (4h) or null (5m/15m). On a cold load the
 * socket's tick buffer starts empty, so a mid-window open can't resolve the boundary
 * tick until the NEXT window — up to the full timeframe with no arrow. The crypto-price
 * API with the window variant returns the exact per-slot open, so fetch it once per
 * window when the stream can't answer. Shares the focused card's query key → one fetch.
 * Non-rolling priceToBeat matches the crypto-price openPrice, so it stays the fallback there.
 */
export function useSpotLean(coin: CoinId, market: ParsedMarket | null): SpotLean {
  const { tick } = useChainlinkSpot(coin)
  const now = useNow()
  const pair = chainlinkPair(coin)

  // Narrowed alias so the compiler enforces the guard instead of `!` assertions.
  const live = pair && market && market.isLive && market.startDate ? market : null
  const startMs = live?.startDate?.getTime() ?? 0
  const rolling = live != null && isRollingSlug(live.eventSlug)

  const boundaryStrike =
    live && pair && startMs > 0 ? chainlinkSocket.strikeAtBoundary(pair, startMs, rolling) : null

  const window = rolling && live ? cryptoPriceWindowParams(live) : null
  const needFallback =
    boundaryStrike == null && window != null && now - startMs > STRIKE_FALLBACK_DELAY_MS
  const windowQuery = useQuery({
    queryKey:
      window && live
        ? qk.cryptoWindow(coin, live.timeframe, live.eventSlug, window.eventStartTime, window.endDate)
        : (['cryptoWindow', 'lean-idle', coin] as const),
    queryFn: () =>
      fetchCryptoPrice(coinSymbol(coin), window!.eventStartTime, window!.endDate, window!.variant),
    enabled: needFallback,
    // The per-slot open is immutable once the window runs; only re-ask while it's
    // missing (upstream can lag in a window's first seconds), and back off on errors.
    refetchInterval: (q) =>
      q.state.status === 'error' ? 10_000 : validPrice(q.state.data?.openPrice) != null ? false : 5_000,
    staleTime: Infinity,
    gcTime: 60_000,
    retry: 1,
    structuralSharing: false,
  })

  if (!live || !pair) return EMPTY

  const fallbackStrike = validPrice(windowQuery.data?.openPrice)

  const strike = boundaryStrike ?? (rolling ? fallbackStrike : live.priceToBeat)
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
