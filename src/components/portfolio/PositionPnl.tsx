import {
  computePositionLiveStats,
  formatPnlPct,
  formatPnlUsd,
  livePositionMark,
} from '@/lib/positionPnl'
import { cn } from '@/lib/utils'
import type { TokenQuote } from '@/lib/clobSocket'
import type { Position } from '@/lib/api'

/** Live value + P&L for a position, using the position token's own live bid when available. */
export function PositionPnl({
  position,
  quote,
  compact = false,
}: {
  position: Position
  quote?: TokenQuote
  compact?: boolean
}) {
  const livePrice = livePositionMark(position, quote)
  const stats = computePositionLiveStats(position, livePrice)

  if (stats.liveValue == null) {
    return <span className="text-xs text-muted-foreground">—</span>
  }

  const positive = (stats.pnl ?? 0) >= 0
  const showPnl = stats.costBasis != null && stats.costBasis > 0 && stats.pnl != null
  return (
    <div className={cn('flex flex-col items-end gap-0.5', !compact && 'gap-1')}>
      <span className={cn('font-extrabold tabular-nums', compact ? 'text-sm' : 'text-base')}>
        ${stats.liveValue.toFixed(2)}
      </span>
      {showPnl && (
        <span className={cn('text-xs font-bold tabular-nums', positive ? 'text-up' : 'text-down')}>
          {formatPnlUsd(stats.pnl!)}
          {stats.pnlPct != null && <span className="ml-1.5 opacity-90">{formatPnlPct(stats.pnlPct)}</span>}
        </span>
      )}
    </div>
  )
}
