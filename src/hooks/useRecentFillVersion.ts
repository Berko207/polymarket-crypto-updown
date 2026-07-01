import { useSyncExternalStore } from 'react'
import { getRecentFillsVersion, subscribeRecentFills } from '@/lib/recentFills'

/** Re-render when optimistic buy/sell overlays change (not tied to query poll). */
export function useRecentFillVersion(): number {
  return useSyncExternalStore(subscribeRecentFills, getRecentFillsVersion, getRecentFillsVersion)
}
