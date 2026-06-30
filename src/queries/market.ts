import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { fetchCurrentMarket } from '@/lib/polymarket'
import { COINS, getAvailableTimeframes } from '@/lib/config'
import { quoteToPrice, type TokenQuoteMap } from '@/lib/clobSocket'
import { useTokenQuotes } from '@/hooks/useTokenQuotes'
import { useUpdateConfig } from '@/store/ui'
import type { CoinId, ParsedMarket, TimeframeId } from '@/lib/types'
import { qk } from './keys'

/** Overlay live WS quotes on a polled market snapshot (matches the old useMarket merge). */
export function mergeLiveQuotes(market: ParsedMarket, quotes: TokenQuoteMap): ParsedMarket {
  const up = market.upTokenId ? quotes[market.upTokenId] : undefined
  const down = market.downTokenId ? quotes[market.downTokenId] : undefined

  const upPrice = quoteToPrice(up) ?? market.upPrice
  const downPrice = quoteToPrice(down) ?? market.downPrice
  const bestBidUp = up?.bestBid ?? market.bestBidUp
  const bestAskUp = up?.bestAsk ?? market.bestAskUp
  const bestBidDown = down?.bestBid ?? market.bestBidDown
  const bestAskDown = down?.bestAsk ?? market.bestAskDown

  const hasLive = up != null || down != null
  if (!hasLive) return market
  if (
    upPrice === market.upPrice &&
    downPrice === market.downPrice &&
    bestBidUp === market.bestBidUp &&
    bestAskUp === market.bestAskUp &&
    bestBidDown === market.bestBidDown &&
    bestAskDown === market.bestAskDown
  ) {
    return market
  }
  return { ...market, upPrice, downPrice, bestBidUp, bestAskUp, bestBidDown, bestAskDown }
}

/** Single market poll (no live overlay). Shares its cache key with the watchlist row. */
export function useMarketQuery(coin: CoinId, timeframe: TimeframeId, pollMs: number) {
  return useQuery({
    queryKey: qk.market(coin, timeframe),
    queryFn: () => fetchCurrentMarket(coin, timeframe),
    refetchInterval: pollMs,
  })
}

export interface LiveMarket {
  market: ParsedMarket | null
  isLoading: boolean
  isError: boolean
  error: unknown
  connected: boolean
  refetch: () => void
}

/** Focused market: polled snapshot + live WS overlay, driven by the update-mode config. */
export function useLiveMarket(coin: CoinId, timeframe: TimeframeId): LiveMarket {
  const config = useUpdateConfig()
  const query = useMarketQuery(coin, timeframe, config.pollMs)
  const market = query.data ?? null

  const tokenIds = useMemo(
    () => [market?.upTokenId, market?.downTokenId].filter(Boolean) as string[],
    [market?.upTokenId, market?.downTokenId],
  )
  const { quotes, connected } = useTokenQuotes(tokenIds, {
    enabled: config.useWebSocket,
    throttleMs: config.throttleMs,
  })

  const displayMarket = useMemo(
    () => (market && config.useWebSocket ? mergeLiveQuotes(market, quotes) : market),
    [market, config.useWebSocket, quotes],
  )

  return {
    market: displayMarket,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    connected,
    refetch: () => void query.refetch(),
  }
}

export interface WatchlistEntry {
  coin: CoinId
  available: boolean
  market: ParsedMarket | null
  isLoading: boolean
  isError: boolean
}

/** Every coin's current market for a timeframe — the overview list (no live overlay here;
 * the watchlist component applies live odds via {@link useWatchlistQuotes}). */
export function useWatchlistQuery(timeframe: TimeframeId, pollMs: number): WatchlistEntry[] {
  const coins = useMemo(
    () => COINS.map((c) => ({ coin: c.id, available: getAvailableTimeframes(c.id).includes(timeframe) })),
    [timeframe],
  )

  const results = useQueries({
    queries: coins.map(({ coin, available }) => ({
      queryKey: qk.market(coin, timeframe),
      queryFn: () => fetchCurrentMarket(coin, timeframe),
      enabled: available,
      refetchInterval: pollMs,
    })),
  })

  return coins.map((c, i) => ({
    coin: c.coin,
    available: c.available,
    market: results[i].data ?? null,
    isLoading: c.available && results[i].isLoading,
    isError: results[i].isError,
  }))
}

/** Subscribe every watchlist outcome token to the shared socket and return live quotes. */
export function useWatchlistQuotes(entries: WatchlistEntry[]) {
  const config = useUpdateConfig()
  const tokenIds = useMemo(() => {
    const ids: string[] = []
    for (const e of entries) {
      if (e.market?.upTokenId) ids.push(e.market.upTokenId)
      if (e.market?.downTokenId) ids.push(e.market.downTokenId)
    }
    return ids
  }, [entries])

  return useTokenQuotes(tokenIds, { enabled: config.useWebSocket, throttleMs: config.throttleMs })
}
