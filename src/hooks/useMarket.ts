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

  const load = useCallback(async () => {
    try {
      setError(null)
      const data = await fetchCurrentMarket(coin, timeframe)
      setMarket(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load market')
      setMarket(null)
    } finally {
      setLoading(false)
    }
  }, [coin, timeframe])

  useEffect(() => {
    setLoading(true)
    void load()
    const id = setInterval(() => void load(), config.pollMs)
    return () => clearInterval(id)
  }, [load, config.pollMs])

  const rolloverKey = useMemo(() => {
    if (!market) return null
    const { target } = getCountdownTarget(market)
    return `${market.eventSlug}:${target.getTime()}`
  }, [market])

  useEffect(() => {
    if (!market || rolloverKey == null) return

    const { target } = getCountdownTarget(market)
    const ms = target.getTime() - Date.now()

    if (ms <= 0) {
      void load()
      const retry = setInterval(() => void load(), 3_000)
      return () => clearInterval(retry)
    }

    const id = setTimeout(() => void load(), ms + 750)
    return () => clearTimeout(id)
  }, [market, rolloverKey, load])

  const displayMarket = useMemo((): ParsedMarket | null => {
    if (!market) return null

    if (!config.useWebSocket) return market

    const hasLive =
      live.upPrice != null ||
      live.downPrice != null ||
      live.bestBidUp != null ||
      live.bestAskUp != null

    if (!hasLive) return market

    return {
      ...market,
      upPrice: live.upPrice ?? market.upPrice,
      downPrice: live.downPrice ?? market.downPrice,
      bestBidUp: live.bestBidUp ?? market.bestBidUp,
      bestAskUp: live.bestAskUp ?? market.bestAskUp,
      bestBidDown: live.bestBidDown ?? market.bestBidDown,
      bestAskDown: live.bestAskDown ?? market.bestAskDown,
    }
  }, [market, live, config.useWebSocket])

  return {
    market: displayMarket,
    loading,
    error,
    refresh: load,
  }
}
