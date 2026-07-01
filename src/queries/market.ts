import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { COINS, getAvailableTimeframes } from '@/lib/config'
import { marketMatchesScope, isCurrentWindow } from '@/lib/marketScope'
import { marketQueryOptions } from '@/queries/marketOptions'
import { quoteToPrice, quoteHasBook, type TokenQuoteMap } from '@/lib/clobSocket'
import { useTokenQuotes } from '@/hooks/useTokenQuotes'
import { useNow } from '@/hooks/useNow'
import { useUpdateConfig } from '@/store/ui'
import type { CoinId, ParsedMarket, TimeframeId } from '@/lib/types'

/** Drop ended windows even if TanStack hasn't refetched yet. */
function freshMarket(market: ParsedMarket | null, now: number): ParsedMarket | null {
  if (!market) return null
  return isCurrentWindow(market, now) ? market : null
}

/** Polled market with live WS overlay when the window is still tradeable. */
export function withLiveQuotes(
  market: ParsedMarket | null,
  quotes: TokenQuoteMap,
  useWebSocket: boolean,
  now = Date.now(),
  { allowEnded = false }: { allowEnded?: boolean } = {},
): ParsedMarket | null {
  if (!market) return null
  if (!allowEnded && !isCurrentWindow(market, now)) return null
  if (!useWebSocket || !market.isLive) return market
  return mergeLiveQuotes(market, quotes)
}

/** Overlay live WS quotes on a polled market snapshot (matches the old useMarket merge). */
export function mergeLiveQuotes(market: ParsedMarket, quotes: TokenQuoteMap): ParsedMarket {
  const up = market.upTokenId ? quotes[market.upTokenId] : undefined
  const down = market.downTokenId ? quotes[market.downTokenId] : undefined

  const upLive = quoteToPrice(up)
  const downLive = quoteToPrice(down)

  let upPrice = upLive ?? market.upPrice
  let downPrice = downLive ?? market.downPrice
  // Thin books often update one side first — keep Up + Down ≈ 100%.
  if (upLive != null && downLive == null) downPrice = 1 - upPrice
  else if (downLive != null && upLive == null) upPrice = 1 - downPrice
  const bestBidUp = up?.bestBid ?? market.bestBidUp
  const bestAskUp = up?.bestAsk ?? market.bestAskUp
  const bestBidDown = down?.bestBid ?? market.bestBidDown
  const bestAskDown = down?.bestAsk ?? market.bestAskDown

  const hasLive = quoteHasBook(up) || quoteHasBook(down)
  if (!hasLive) return market

  // Stale socket rows from a prior window can sit at ~0 or ~1 — ignore wild drift.
  const upDrift = upLive != null ? Math.abs(upLive - market.upPrice) : 0
  const downDrift = downLive != null ? Math.abs(downLive - market.downPrice) : 0
  const maxDrift = Math.max(upDrift, downDrift)
  if (maxDrift > 0.35) {
    return market
  }

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
  return useQuery(marketQueryOptions(coin, timeframe, pollMs))
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

/** True when polled market belongs to the selected coin + timeframe tab. */
export { marketMatchesScope } from '@/lib/marketScope'

/** Focused market: polled snapshot + live WS overlay, driven by the update-mode config. */
export function useLiveMarket(coin: CoinId, timeframe: TimeframeId): LiveMarket {
  const config = useUpdateConfig()
  const now = useNow()
  const scopeKey = `${coin}:${timeframe}`
  // The CLOB WS is snapshot-then-sparse for these markets, so the focused card can sit
  // stale between ticks. Poll the (edge-cached ~5s) gamma snapshot faster when streaming so
  // the center refreshes even while the book is quiet. Saver keeps its low-data 30s cadence.
  const focusedPollMs = config.useWebSocket ? Math.min(config.pollMs, 6_000) : config.pollMs
  const query = useMarketQuery(coin, timeframe, focusedPollMs)

  // Retain the last window only during rollover fetches so the card doesn't blank.
  const lastMarketRef = useRef<{ scope: string; market: ParsedMarket | null }>({
    scope: '',
    market: null,
  })
  if (lastMarketRef.current.scope !== scopeKey) {
    lastMarketRef.current = { scope: scopeKey, market: null }
  }

  const queryMarket = freshMarket(query.data ?? null, now)
  if (queryMarket && marketMatchesScope(queryMarket, coin, timeframe)) {
    lastMarketRef.current = { scope: scopeKey, market: queryMarket }
  }

  const refetchRef = useRef<() => void>(() => {})
  refetchRef.current = () => void query.refetch()
  const refetch = useCallback(() => refetchRef.current(), [])

  const sameScope = lastMarketRef.current.scope === scopeKey
  const rolloverSource = queryMarket ?? (sameScope ? lastMarketRef.current.market : null)
  const rolling = useMarketRollover(
    rolloverSource ? rolloverSource.endDate.getTime() : null,
    refetch,
  )

  const retained =
    !queryMarket && rolling && sameScope ? lastMarketRef.current.market : null
  const market =
    queryMarket ??
    (retained && marketMatchesScope(retained, coin, timeframe) ? retained : null)

  const tokenIds = useMemo(
    () => [market?.upTokenId, market?.downTokenId].filter(Boolean) as string[],
    [market?.upTokenId, market?.downTokenId],
  )
  const { quotes, connected } = useTokenQuotes(tokenIds, {
    enabled: tokenIds.length > 0,
    throttleMs: 0,
  })

  const displayMarket = useMemo(() => {
    const live = withLiveQuotes(market, quotes, true, now, { allowEnded: rolling })
    if (!live || !marketMatchesScope(live, coin, timeframe)) return null
    return live
  }, [market, coin, timeframe, quotes, now, rolling])

  const switching =
    !displayMarket &&
    (query.isLoading || query.isFetching || (queryMarket == null && query.isFetched && !rolling))
  const isLoading = switching

  return {
    market: displayMarket,
    isLoading,
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
export function useWatchlistQuery(
  timeframe: TimeframeId,
  pollMs: number,
  now: number,
): WatchlistEntry[] {
  const coins = useMemo(
    () => COINS.map((c) => ({ coin: c.id, available: getAvailableTimeframes(c.id).includes(timeframe) })),
    [timeframe],
  )

  const results = useQueries({
    queries: coins.map(({ coin, available }) => ({
      ...marketQueryOptions(coin, timeframe, pollMs),
      enabled: available,
    })),
  })

  return coins.map((c, i) => {
    const raw = freshMarket(results[i].data ?? null, now)
    const market =
      raw && marketMatchesScope(raw, c.coin, timeframe) ? raw : null
    return {
      coin: c.coin,
      available: c.available,
      market,
      isLoading: c.available && (results[i].isLoading || results[i].isFetching) && !market,
      isError: results[i].isError,
    }
  })
}

/** Subscribe every watchlist outcome token to the shared socket and return live quotes. */
export function useWatchlistQuotes(entries: WatchlistEntry[]) {
  const config = useUpdateConfig()
  const entriesKey = entries
    .map((e) => `${e.coin}:${e.market?.eventSlug ?? ''}:${e.market?.upTokenId ?? ''}`)
    .join('|')

  const tokenIds = useMemo(() => {
    const ids: string[] = []
    for (const e of entries) {
      if (e.market?.upTokenId) ids.push(e.market.upTokenId)
      if (e.market?.downTokenId) ids.push(e.market.downTokenId)
    }
    return ids
  }, [entriesKey])

  return useTokenQuotes(tokenIds, { enabled: config.useWebSocket, throttleMs: config.throttleMs })
}
