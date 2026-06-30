import { useEffect } from 'react'
import { warmTradingPath } from '@/lib/api'

/** Prefetch server-side order metadata when a tradeable market is on screen. */
export function useWarmTradingPath(tokenIds: string[], enabled: boolean): void {
  const key = tokenIds.filter(Boolean).join(',')

  useEffect(() => {
    if (!enabled || !key) return
    void warmTradingPath(key.split(',')).catch(() => {})
  }, [enabled, key])
}
