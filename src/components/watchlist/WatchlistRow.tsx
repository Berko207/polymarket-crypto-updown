import { getCoin } from '@/lib/config'
import { cn } from '@/lib/utils'
import { CoinBadge } from '@/components/common/CoinBadge'
import type { CoinId } from '@/lib/types'

export function WatchlistRow({
  coin,
  upPrice,
  available,
  isLoading,
  selected,
  onSelect,
}: {
  coin: CoinId
  upPrice: number | null
  available: boolean
  isLoading: boolean
  selected: boolean
  onSelect: (coin: CoinId) => void
}) {
  const meta = getCoin(coin)
  const pct = upPrice != null ? Math.round(upPrice * 100) : null

  return (
    <button
      type="button"
      onClick={() => onSelect(coin)}
      aria-current={selected}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
        selected ? 'bg-secondary ring-1 ring-primary/40' : 'hover:bg-secondary/60',
      )}
    >
      <CoinBadge coin={coin} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">{meta.symbol}</span>
          <span className="text-sm font-bold tabular-nums">
            {!available ? (
              <span className="text-muted-foreground">—</span>
            ) : pct != null ? (
              `${pct}%`
            ) : isLoading ? (
              <span className="text-muted-foreground">··</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </span>
        </div>
        {available && pct != null && (
          <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-border" aria-hidden="true">
            <div className="bg-up" style={{ width: `${pct}%` }} />
            <div className="bg-down" style={{ width: `${100 - pct}%` }} />
          </div>
        )}
      </div>
    </button>
  )
}
