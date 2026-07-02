import { formatCents } from '@/lib/polymarket'
import { formatPositionLabel } from '@/lib/marketLabels'
import { livePositionMark } from '@/lib/positionPnl'
import { MIN_POSITION_SIZE } from '@/queries/portfolio'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { OutcomeBadge, outcomeSide } from '@/components/common/OutcomeBadge'
import { TimeframeBadge } from '@/components/common/TimeframeBadge'
import { PositionPnl } from './PositionPnl'
import type { TokenQuote } from '@/lib/clobSocket'
import type { Position } from '@/lib/api'

function PositionPriceLine({
  bought,
  live,
}: {
  bought: number | null
  live: number | null
}) {
  if (bought == null && live == null) {
    return <span className="text-xs text-muted-foreground">—</span>
  }

  const delta =
    bought != null && live != null ? Math.round((live - bought) * 100) : null
  const liveColor =
    delta == null
      ? 'text-foreground'
      : delta > 0
        ? 'text-up'
        : delta < 0
          ? 'text-down'
          : 'text-muted-foreground'

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums">
      {bought != null && (
        <span className="text-muted-foreground">
          Bought <span className="font-semibold text-foreground">{formatCents(bought)}</span>
        </span>
      )}
      {bought != null && live != null && (
        <span className="text-muted-foreground/50" aria-hidden>
          →
        </span>
      )}
      {live != null && (
        <span className={cn('font-bold', liveColor)}>
          Now {formatCents(live)}
          {delta != null && delta !== 0 && (
            <span className="ml-1 font-semibold opacity-90">
              ({delta > 0 ? '+' : ''}
              {delta}¢)
            </span>
          )}
        </span>
      )}
    </div>
  )
}

export function PositionRow({
  position,
  quote,
  selling = false,
  sellFirst = false,
  settling = false,
  onSell,
}: {
  position: Position
  quote?: TokenQuote
  selling?: boolean
  sellFirst?: boolean
  /** Market window ended, resolution not yet indexed — frozen, nothing to sell into. */
  settling?: boolean
  onSell: (position: Position, sellPrice: number) => void
}) {
  const { short, timeframeLabel, asset, window } = formatPositionLabel(position)
  const detail = [asset, window].filter(Boolean).join(' · ') || short
  const side = outcomeSide(position.outcome)
  const live = livePositionMark(position, quote)
  // Sell mark is the best available price (live bid → mid/last → polled snapshot), not
  // just the WS bid: it's only a server hint (the book is walked anyway), so gating the
  // Sell button on a live bid needlessly blocks selling in saver mode / before first quote.
  const sellMark = live
  const proceeds = sellMark != null ? position.size * sellMark : null
  const avgPrice =
    position.avgPrice > 0
      ? position.avgPrice
      : position.initialValue != null && position.initialValue > 0 && position.size > 0
        ? position.initialValue / position.size
        : null
  const cost = avgPrice != null ? position.size * avgPrice : null

  return (
    <li className="flex items-start justify-between gap-3 rounded-lg bg-secondary px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <OutcomeBadge outcome={position.outcome} />
          {timeframeLabel && <TimeframeBadge label={timeframeLabel} />}
          <span className="truncate text-sm font-medium">{detail}</span>
          {sellFirst && (
            <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide text-primary">
              Sell 1st
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-col gap-1">
          <div className="text-xs text-muted-foreground tabular-nums">
            {position.size.toFixed(2)} shares
            {cost != null && <span className="ml-2">· ${cost.toFixed(2)} cost</span>}
          </div>
          <PositionPriceLine bought={avgPrice} live={live} />
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <PositionPnl position={position} quote={quote} compact />
        <Button
          size="xs"
          variant="ghost"
          className={cn('h-6 px-2', side === 'up' ? 'text-up' : 'text-down')}
          disabled={
            selling ||
            settling ||
            sellMark == null ||
            position.redeemable ||
            position.size < MIN_POSITION_SIZE
          }
          onClick={() => sellMark != null && onSell(position, sellMark)}
        >
          {selling
            ? 'Selling…'
            : settling
              ? 'Resolving…'
              : position.redeemable
                ? 'Resolved'
                : proceeds != null
                  ? `Sell ≈$${proceeds.toFixed(2)}`
                  : 'Sell'}
        </Button>
      </div>
    </li>
  )
}
