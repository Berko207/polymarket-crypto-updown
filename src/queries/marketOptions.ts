import { fetchCurrentMarket } from '@/lib/polymarket'
import { marketMatchesScope } from '@/lib/marketScope'
import { qk } from '@/queries/keys'
import type { CoinId, TimeframeId } from '@/lib/types'

/** Shared TanStack options — watchlist + focused market must agree or cache goes stale. */
export function marketQueryOptions(coin: CoinId, timeframe: TimeframeId, pollMs: number) {
  return {
    queryKey: qk.market(coin, timeframe),
    queryFn: async () => {
      const data = await fetchCurrentMarket(coin, timeframe)
      if (!data || !marketMatchesScope(data, coin, timeframe)) return null
      return data
    },
    refetchInterval: pollMs,
    staleTime: 0,
    gcTime: 60_000,
    refetchOnMount: 'always' as const,
    structuralSharing: false as const,
  }
}
