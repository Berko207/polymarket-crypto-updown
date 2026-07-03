import { useLayoutEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useChainlinkSpot } from '@/hooks/useChainlinkSpot'
import {
  chainlinkPair,
  coinSymbol,
  cryptoPriceWindowParams,
  fetchCryptoPrice,
  isRollingSlug,
  previousWindowParams,
} from '@/lib/cryptoPrice'
import { chainlinkSocket } from '@/lib/chainlinkSocket'
import { marketMatchesScope, marketWindowKey } from '@/lib/marketScope'
import { qk } from '@/queries/keys'
import type { CoinId, ParsedMarket, TimeframeId } from '@/lib/types'

function validPrice(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

export type StrikePhase = 'upcoming' | 'preview' | 'loading' | 'locked' | 'unavailable'
export type CurrentPhase = 'loading' | 'live' | 'polled' | 'final'

export interface MarketSpot {
  strike: number | null
  strikePhase: StrikePhase
  current: number | null
  currentPhase: CurrentPhase
  delta: number | null
  completed: boolean
}

/** True when order-book Up% disagrees with spot vs strike (meaningful move). */
export function spotOddsDiverge(spot: MarketSpot, upPrice: number): boolean {
  if (spot.delta == null || spot.strike == null || spot.strike <= 0) return false
  const spotUp = spot.delta >= 0
  const marketUp = upPrice >= 0.5
  if (spotUp === marketUp) return false
  const minDelta = spot.strike * 0.0001
  return Math.abs(spot.delta) >= minDelta && (upPrice > 0.55 || upPrice < 0.45)
}

/**
 * Spot prices for the focused market window.
 * Rolling strikes: Chainlink boundary tick, else prior-window close.
 * Current (in-window): Chainlink WS when available; API close at resolution.
 */
export function useMarketSpot(
  market: ParsedMarket | null | undefined,
  coin: CoinId,
  timeframe: TimeframeId,
): MarketSpot {
  const inScope = Boolean(market && marketMatchesScope(market, coin, timeframe))
  const window = market ? cryptoPriceWindowParams(market) : null
  const windowKey = market ? marketWindowKey(market) : `${coin}:${timeframe}:none`
  const symbol = coinSymbol(market?.coin ?? coin)
  const pair = chainlinkPair(market?.coin ?? coin)
  const rolling = market ? isRollingSlug(market.eventSlug) : false

  const startMs = market?.startDate?.getTime() ?? 0
  const endMs = market?.endDate.getTime() ?? 0

  const [now, setNow] = useState(() => Date.now())
  useLayoutEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [windowKey])

  const started = startMs > 0 && now >= startMs
  const ended = now >= endMs

  const { tick } = useChainlinkSpot(market?.coin ?? coin)

  const query = useQuery({
    queryKey: window
      ? qk.cryptoWindow(coin, timeframe, market!.eventSlug, window.eventStartTime, window.endDate)
      : (['cryptoWindow', 'pending', windowKey] as const),
    queryFn: () => fetchCryptoPrice(symbol, window!.eventStartTime, window!.endDate),
    enabled: inScope && window != null,
    refetchInterval: (q) => {
      if (q.state.status === 'error') return 10_000
      if (q.state.data?.completed) return false
      return 2_000
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    retry: 2,
    structuralSharing: false,
  })

  const prevWindow = rolling && market ? previousWindowParams(market) : null
  const prevQuery = useQuery({
    queryKey: prevWindow
      ? qk.cryptoWindowPrev(coin, timeframe, market!.eventSlug, prevWindow.eventStartTime, prevWindow.endDate)
      : (['cryptoWindowPrev', 'pending', windowKey] as const),
    queryFn: () => fetchCryptoPrice(symbol, prevWindow!.eventStartTime, prevWindow!.endDate),
    enabled: inScope && rolling && started && prevWindow != null,
    staleTime: 0,
    gcTime: 0,
    retry: 2,
    structuralSharing: false,
  })

  if (!inScope || !window) {
    return {
      strike: null,
      strikePhase: 'upcoming',
      current: null,
      currentPhase: 'loading',
      delta: null,
      completed: false,
    }
  }

  const windowReady = !query.isPending && !query.isFetching
  const prevReady = !prevWindow || (!prevQuery.isPending && !prevQuery.isFetching)

  const apiOpen = windowReady ? validPrice(query.data?.openPrice) : null
  const apiClose = windowReady ? validPrice(query.data?.closePrice) : null
  const chainlinkStrike =
    started && pair && startMs > 0
      ? chainlinkSocket.strikeAtBoundary(pair, startMs, rolling)
      : null
  const prevClose = prevReady ? validPrice(prevQuery.data?.closePrice) : null

  const preview = !started && market ? validPrice(market.priceToBeat) : null

  let strike: number | null
  if (!started) {
    strike = preview
  } else if (rolling) {
    // PM crypto-price openPrice is the hour anchor for nested 5m/15m windows — not per-slot.
    // Window open = Chainlink tick at slug boundary, else prior window close.
    strike = chainlinkStrike ?? prevClose
    if (strike == null && windowReady && market!.timeframe !== '5m') {
      strike = apiOpen
    }
  } else {
    strike = apiOpen ?? chainlinkStrike
  }

  const completed = query.data?.completed ?? ended
  const apiInProgressClose = !completed ? validPrice(query.data?.closePrice) : null

  let strikePhase: StrikePhase
  if (!started) {
    strikePhase = preview != null ? 'preview' : 'upcoming'
  } else if (strike != null) {
    strikePhase = 'locked'
  } else if (rolling && (!prevReady || (prevWindow != null && prevQuery.isPending) || query.isPending)) {
    strikePhase = 'loading'
  } else if (!rolling && query.isPending) {
    strikePhase = 'loading'
  } else if (query.isError || prevQuery.isError) {
    strikePhase = 'unavailable'
  } else {
    strikePhase = 'unavailable'
  }

  const chainlinkLive = tick && Number.isFinite(tick.value) ? tick.value : null
  const usingChainlink = !completed && chainlinkLive != null

  // In-window: Chainlink WS for live UI; API close at resolution / when WS is off.
  const current = completed
    ? (apiClose ?? chainlinkLive)
    : usingChainlink
      ? chainlinkLive
      : (apiInProgressClose ?? chainlinkLive ?? apiClose)

  const currentPhase: CurrentPhase = completed
    ? 'final'
    : usingChainlink
      ? 'live'
      : current != null
        ? 'polled'
        : 'loading'

  const delta = strike != null && current != null ? current - strike : null

  return {
    strike,
    strikePhase,
    current,
    currentPhase,
    delta,
    completed,
  }
}
