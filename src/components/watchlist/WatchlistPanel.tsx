import { useWatchlistQuery, useWatchlistQuotes } from '@/queries/market'
import { useUpdateConfig } from '@/store/ui'
import { midFromQuotes } from '@/lib/clobSocket'
import { TimeframeTabs } from './TimeframeTabs'
import { WatchlistRow } from './WatchlistRow'
import type { CoinId, TimeframeId } from '@/lib/types'

export function WatchlistPanel({
  timeframe,
  selectedCoin,
  onSelectCoin,
  onSelectTimeframe,
}: {
  timeframe: TimeframeId
  selectedCoin: CoinId
  onSelectCoin: (coin: CoinId) => void
  onSelectTimeframe: (timeframe: TimeframeId) => void
}) {
  const config = useUpdateConfig()
  const entries = useWatchlistQuery(timeframe, config.pollMs)
  const { quotes } = useWatchlistQuotes(entries)

  return (
    <div className="flex flex-col gap-3">
      <TimeframeTabs selected={timeframe} onChange={onSelectTimeframe} />
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => {
          const live = entry.market?.upTokenId ? midFromQuotes(quotes, entry.market.upTokenId) : null
          const upPrice = entry.available ? (live ?? entry.market?.upPrice ?? null) : null
          return (
            <li key={entry.coin}>
              <WatchlistRow
                coin={entry.coin}
                upPrice={upPrice}
                available={entry.available}
                isLoading={entry.isLoading}
                selected={entry.coin === selectedCoin}
                onSelect={onSelectCoin}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
