import { useWatchlistQuery, useWatchlistQuotes, withLiveQuotes } from '@/queries/market'
import { useUpdateConfig } from '@/store/ui'
import { useNow } from '@/hooks/useNow'
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
  const now = useNow()
  const entries = useWatchlistQuery(timeframe, config.pollMs, now)
  const { quotes } = useWatchlistQuotes(entries)

  return (
    <div className="flex flex-col gap-3">
      <TimeframeTabs selected={timeframe} coin={selectedCoin} onChange={onSelectTimeframe} />
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => {
          const live = withLiveQuotes(entry.market, quotes, config.useWebSocket, now)
          const upPrice = entry.available ? (live?.upPrice ?? null) : null
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
