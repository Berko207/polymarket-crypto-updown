import { TIMEFRAMES, getAvailableTimeframes } from '@/lib/config'
import { cn } from '@/lib/utils'
import type { CoinId, TimeframeId } from '@/lib/types'

export function TimeframeTabs({
  selected,
  coin,
  onChange,
}: {
  selected: TimeframeId
  coin: CoinId
  onChange: (timeframe: TimeframeId) => void
}) {
  const available = getAvailableTimeframes(coin)

  return (
    <div className="flex gap-1 rounded-lg bg-secondary p-1" role="tablist" aria-label="Timeframe">
      {TIMEFRAMES.map((tf) => {
        const enabled = available.includes(tf.id)
        return (
          <button
            key={tf.id}
            type="button"
            role="tab"
            aria-selected={selected === tf.id}
            aria-disabled={!enabled}
            disabled={!enabled}
            title={enabled ? undefined : `Not available for ${coin.toUpperCase()}`}
            onClick={() => enabled && onChange(tf.id)}
            className={cn(
              'flex-1 rounded-md px-2 py-1 text-xs font-semibold transition-colors',
              selected === tf.id
                ? 'bg-background text-foreground shadow-sm'
                : enabled
                  ? 'text-muted-foreground hover:text-foreground'
                  : 'cursor-not-allowed text-muted-foreground/35',
            )}
          >
            {tf.shortLabel}
          </button>
        )
      })}
    </div>
  )
}
