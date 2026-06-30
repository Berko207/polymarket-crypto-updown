import type { CoinId, TimeframeId } from '@/lib/types'

/** Central query-key factory. The focused market and its watchlist row share a
 * key, so they dedupe into one cache entry / one network request. */
export const qk = {
  market: (coin: CoinId, timeframe: TimeframeId) => ['market', coin, timeframe] as const,
  account: ['account'] as const,
  orders: ['orders'] as const,
  positions: ['positions'] as const,
}
