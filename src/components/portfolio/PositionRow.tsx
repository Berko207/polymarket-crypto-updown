import { formatPercent } from '@/lib/polymarket'
import { formatPositionLabel } from '@/lib/marketLabels'
import { MIN_POSITION_SIZE } from '@/queries/portfolio'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { OutcomeBadge, outcomeSide } from '@/components/common/OutcomeBadge'
import { TimeframeBadge } from '@/components/common/TimeframeBadge'
import { PositionPnl } from './PositionPnl'
import type { TokenQuote } from '@/lib/clobSocket'
import type { Position } from '@/lib/api'

export function PositionRow({
  position,
  quote,
  selling = false,
  sellFirst = false,
  onSell,
}: {
  position: Position
  quote?: TokenQuote
  selling?: boolean
  sellFirst?: boolean
  onSell: (position: Position, sellPrice: number) => void
}) {
  const { short, timeframeLabel, asset, window } = formatPositionLabel(position)
  const detail = [asset, window].filter(Boolean).join(' · ') || short
  const side = outcomeSide(position.outcome)
  // Strict live bid — what a market sell would actually realize. Null (no bid) keeps
  // the Sell button disabled rather than selling into a stale polled price.
  const bid = quote?.bestBid ?? null

  return (
    <li className="flex items-center justify-between gap-3 rounded-lg bg-secondary px-3 py-2">
      <div className="min-w-0">
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
        <div className="mt-1 text-xs text-muted-foreground">
          {position.size.toFixed(2)} shares
          {position.avgPrice > 0 && <> · cost ${(position.size * position.avgPrice).toFixed(2)}</>}
          {bid != null && <> · bid {formatPercent(bid)}</>}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <PositionPnl position={position} quote={quote} compact />
        <Button
          size="xs"
          variant="ghost"
          className={cn('h-6 px-2', side === 'up' ? 'text-up' : 'text-down')}
          disabled={selling || bid == null || position.redeemable || position.size < MIN_POSITION_SIZE}
          onClick={() => bid != null && onSell(position, bid)}
        >
          {selling ? 'Selling…' : position.redeemable ? 'Resolved' : 'Sell'}
        </Button>
      </div>
    </li>
  )
}
