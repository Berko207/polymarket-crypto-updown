import { TIMEFRAMES } from '@/lib/config'
import { cn } from '@/lib/utils'
import type { TimeframeId } from '@/lib/types'

export function TimeframeTabs({
  selected,
  onChange,
}: {
  selected: TimeframeId
  onChange: (timeframe: TimeframeId) => void
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-secondary p-1" role="tablist" aria-label="Timeframe">
      {TIMEFRAMES.map((tf) => (
        <button
          key={tf.id}
          type="button"
          role="tab"
          aria-selected={selected === tf.id}
          onClick={() => onChange(tf.id)}
          className={cn(
            'flex-1 rounded-md px-2 py-1 text-xs font-semibold transition-colors',
            selected === tf.id
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {tf.shortLabel}
        </button>
      ))}
    </div>
  )
}
