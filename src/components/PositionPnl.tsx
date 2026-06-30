import {
  computePositionLiveStats,
  formatPnlPct,
  formatPnlUsd,
  livePriceForPosition,
} from '../lib/positionPnl'
import type { Position } from '../lib/api'

interface PositionPnlProps {
  position: Position
  bestBidUp: number | null
  bestBidDown: number | null
  upPrice?: number | null
  downPrice?: number | null
  compact?: boolean
}

export function PositionPnl({
  position,
  bestBidUp,
  bestBidDown,
  upPrice,
  downPrice,
  compact = false,
}: PositionPnlProps) {
  const livePrice = livePriceForPosition(
    position,
    { up: bestBidUp, down: bestBidDown },
    { up: upPrice ?? null, down: downPrice ?? null },
  )
  const stats = computePositionLiveStats(position, livePrice)

  if (stats.liveValue == null) {
    return <span className="position-pnl muted">—</span>
  }

  const pnlClass = stats.pnl == null ? '' : stats.pnl >= 0 ? 'positive' : 'negative'

  return (
    <div className={`position-pnl ${compact ? 'compact' : ''}`}>
      <span className="position-live-value">${stats.liveValue.toFixed(2)}</span>
      {stats.pnl != null && (
        <span className={`position-pnl-change ${pnlClass}`}>
          {formatPnlUsd(stats.pnl)}
          {!compact && stats.pnlPct != null && (
            <span className="position-pnl-pct"> ({formatPnlPct(stats.pnlPct)})</span>
          )}
        </span>
      )}
    </div>
  )
}
