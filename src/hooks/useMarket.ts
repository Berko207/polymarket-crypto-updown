import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchCurrentMarket, getCountdownTarget } from '../lib/polymarket'
import { resolveUpdateConfig, type UpdateMode } from '../lib/updateMode'
import { useLivePrices } from './useLivePrices'
import type { CoinId, ParsedMarket, TimeframeId } from '../lib/types'

export function useMarket(
  coin: CoinId,
  timeframe: TimeframeId,
  updateMode: UpdateMode,
  balancedIntervalMs: number,
) {
  const config = resolveUpdateConfig(updateMode, balancedIntervalMs)
  const [market, setMarket] = useState<ParsedMarket | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const live = useLivePrices(market?.upTokenId ?? null, market?.downTokenId ?? null, {
    enabled: config.useWebSocket,
    throttleMs: config.throttleMs,
  })

  const load = useCallback(async (signal?: { cancelled: boolean }) => {
    try {
      setError(null)
      const data = await fetchCurrentMarket(coin, timeframe)
      if (signal?.cancelled) return
      setMarket(data)
    } catch (err) {
      if (signal?.cancelled) return
      setError(err instanceof Error ? err.message : 'Failed to load market')
      setMarket(null)
    } finally {
      if (!signal?.cancelled) setLoading(false)
    }
  }, [coin, timeframe])

  useEffect(() => {
    const signal = { cancelled: false }
    // Keep the previously loaded market on screen while the next one loads
    // (stale-while-revalidate) so open orders/positions stay visible mid-switch.
    setLoading(true)
    setError(null)
    void load(signal)
    const id = setInterval(() => void load(signal), config.pollMs)
    return () => {
      signal.cancelled = true
      clearInterval(id)
    }
  }, [coin, timeframe, config.pollMs, load])

  const rolloverKey = useMemo(() => {
    if (!market) return null
    const { target } = getCountdownTarget(market)
    return `${market.eventSlug}:${target.getTime()}`
  }, [market])

  useEffect(() => {
    if (!market || rolloverKey == null) return

    const signal = { cancelled: false }
    const { target } = getCountdownTarget(market)
    const ms = target.getTime() - Date.now()

    const run = () => void load(signal)

    if (ms <= 0) {
      run()
      const retry = setInterval(run, 3_000)
      return () => {
        signal.cancelled = true
        clearInterval(retry)
      }
    }

    const id = setTimeout(run, ms + 750)
    return () => {
      signal.cancelled = true
      clearTimeout(id)
    }
    // rolloverKey captures window identity; avoid re-firing on every polled market object.
  }, [rolloverKey, load])

  const displayMarket = useMemo((): ParsedMarket | null => {
    if (!market) return null

    if (!config.useWebSocket) return market

    const upPrice = live.upPrice ?? market.upPrice
    const downPrice = live.downPrice ?? market.downPrice
    const bestBidUp = live.bestBidUp ?? market.bestBidUp
    const bestAskUp = live.bestAskUp ?? market.bestAskUp
    const bestBidDown = live.bestBidDown ?? market.bestBidDown
    const bestAskDown = live.bestAskDown ?? market.bestAskDown

    const hasLive =
      live.upPrice != null ||
      live.downPrice != null ||
      live.bestBidUp != null ||
      live.bestAskUp != null

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

    return {
      ...market,
      upPrice,
      downPrice,
      bestBidUp,
      bestAskUp,
      bestBidDown,
      bestAskDown,
    }
  }, [
    market,
    config.useWebSocket,
    live.upPrice,
    live.downPrice,
    live.bestBidUp,
    live.bestAskUp,
    live.bestBidDown,
    live.bestAskDown,
  ])

  return {
    market: displayMarket,
    loading,
    error,
    refresh: load,
  }
}
