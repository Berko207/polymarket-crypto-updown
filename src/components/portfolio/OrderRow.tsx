import { formatPercent } from '@/lib/polymarket'
import { formatOrderLabel } from '@/lib/marketLabels'
import { Button } from '@/components/ui/button'
import { OutcomeBadge } from '@/components/common/OutcomeBadge'
import type { OpenOrder, Position } from '@/lib/api'

export function OrderRow({
  order,
  positions,
  cancelling = false,
  onCancel,
}: {
  order: OpenOrder
  positions: Position[]
  cancelling?: boolean
  onCancel: (orderId: string) => void
}) {
  const { short } = formatOrderLabel(order, positions)

  return (
    <li className="flex items-start justify-between gap-3 rounded-lg bg-secondary px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <OutcomeBadge outcome={order.outcome} />
          <span className="truncate text-sm font-medium">{short}</span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {order.side} · {order.sizeRemaining.toFixed(2)} @ {formatPercent(order.price)}
          {order.sizeMatched > 0
            ? ` · ${order.sizeMatched.toFixed(2)}/${order.originalSize.toFixed(2)} filled`
            : ' · waiting to fill'}
        </div>
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
