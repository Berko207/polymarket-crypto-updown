import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  /** The current window has ended and we're polling fast for the next round. */
  rolling: boolean
  refetch: () => void
}

/** How fast to re-check for the next round while the current one is resolving. */
const ROLLOVER_RETRY_MS = 2_000
/** Grace period after a window's end before fetching its successor. */
const ROLLOVER_LEAD_MS = 400
/** Stop fast-polling after this many tries; the normal 30s poll then takes over. */
const ROLLOVER_MAX_ATTEMPTS = 20

/**
 * Auto-advance to the next round. The instant the focused window ends, refetch
 * on a fast loop until the next live market appears — instead of sitting on a
 * "Resolving…" clock for up to a full (30s) metadata poll. Returns true while a
 * rollover is in progress so the UI can show a transition hint.
 */
function useMarketRollover(endMs: number | null, refetch: () => void): boolean {
  const [rolling, setRolling] = useState(false)

  useEffect(() => {
    if (endMs == null) {
      setRolling(false)
      return
    }

    const wait = endMs - Date.now()
    // A market whose window is still open means we're not (yet) rolling over.
    if (wait > 0) setRolling(false)

    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = () => {
      if (cancelled) return
      attempts += 1
      refetch()
      if (attempts >= ROLLOVER_MAX_ATTEMPTS) {
        setRolling(false) // give up the fast loop; the normal poll keeps trying
        return
      }
      setRolling(true)
      timer = setTimeout(tick, ROLLOVER_RETRY_MS)
    }

    timer = setTimeout(tick, Math.max(0, wait) + ROLLOVER_LEAD_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [endMs, refetch])

  return rolling
}

/** Focused market: polled snapshot + live WS overlay, driven by the update-mode config. */
export function useLiveMarket(coin: CoinId, timeframe: TimeframeId): LiveMarket {
  const config = useUpdateConfig()
  const query = useMarketQuery(coin, timeframe, config.pollMs)

  // Retain the last resolved market so a transient empty fetch during rollover
  // (the brief gap while the next window goes live) doesn't blank the card.
  const lastMarketRef = useRef<ParsedMarket | null>(null)
  if (query.data) lastMarketRef.current = query.data
  const market = query.data ?? lastMarketRef.current

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

  // Stable refetch identity so the rollover effect only re-arms when the window changes.
  const refetchRef = useRef<() => void>(() => {})
  refetchRef.current = () => void query.refetch()
  const refetch = useCallback(() => refetchRef.current(), [])
  const rolling = useMarketRollover(market ? market.endDate.getTime() : null, refetch)

  return {
    market: displayMarket,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    connected,
    rolling,
    refetch,
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
