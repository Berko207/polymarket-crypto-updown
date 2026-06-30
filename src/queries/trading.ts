import { useEffect } from 'react'
import { warmTradingPath } from '@/lib/api'

/** Prefetch server-side order metadata when a tradeable market is on screen. */
export function useWarmTradingPath(tokenIds: string[], enabled: boolean): void {
  const key = tokenIds.filter(Boolean).join(',')

  useEffect(() => {
    if (!enabled || !key) return
    const ids = key.split(',')
    void warmTradingPath(ids).catch(() => {})
    const timer = setInterval(() => void warmTradingPath(ids).catch(() => {}), 45_000)
    return () => clearInterval(timer)
  }, [enabled, key])
}
