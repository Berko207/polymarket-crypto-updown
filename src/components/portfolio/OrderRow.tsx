import { formatPercent } from '@/lib/polymarket'
import { formatOrderLabel } from '@/lib/marketLabels'
import { quoteToPrice, type TokenQuote } from '@/lib/clobSocket'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { OutcomeBadge } from '@/components/common/OutcomeBadge'
import { TimeframeBadge } from '@/components/common/TimeframeBadge'
import type { OpenOrder, Position } from '@/lib/api'

export function OrderRow({
  order,
  positions,
  quote,
  cancelling = false,
  onCancel,
}: {
  order: OpenOrder
  positions: Position[]
  quote?: TokenQuote
  cancelling?: boolean
  onCancel: (orderId: string) => void
}) {
  const { short, timeframeLabel, asset, window } = formatOrderLabel(order, positions)
  const detail = [asset, window].filter(Boolean).join(' · ') || short

  // Live market price + how far this resting order is from filling. A BUY fills
  // when the ask falls to its limit; a SELL fills when the bid rises to it.
  const isBuy = order.side.toUpperCase() === 'BUY'
  const mid = quoteToPrice(quote)
  const edge = isBuy ? quote?.bestAsk ?? null : quote?.bestBid ?? null
  const gap = edge != null ? (isBuy ? edge - order.price : order.price - edge) : null
  const filling = gap != null && gap <= 0

  return (
    <li className="flex items-start justify-between gap-3 rounded-lg bg-secondary px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <OutcomeBadge outcome={order.outcome} />
          {timeframeLabel && <TimeframeBadge label={timeframeLabel} />}
          <span className="truncate text-sm font-medium">{detail}</span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {order.side} · {order.sizeRemaining.toFixed(2)} @ {formatPercent(order.price)}
          {order.sizeMatched > 0
            ? ` · ${order.sizeMatched.toFixed(2)}/${order.originalSize.toFixed(2)} filled`
            : ' · waiting to fill'}
        </div>
        {mid != null && (
          <div className="mt-0.5 flex items-center gap-1.5 text-xs tabular-nums">
            <span className="text-muted-foreground">Market {formatPercent(mid)}</span>
            {gap != null && (
              <span className={cn('font-medium', filling ? 'text-up' : 'text-muted-foreground')}>
                · {filling ? 'filling' : `${Math.round(gap * 100)}¢ to fill`}
              </span>
            )}
          </div>
        )}
      </div>
      <Button
        size="xs"
        variant="ghost"
        className="h-6 px-2 text-down"
        disabled={cancelling}
        onClick={() => onCancel(order.id)}
      >
        {cancelling ? '…' : 'Cancel'}
      </Button>
    </li>
  )
}
