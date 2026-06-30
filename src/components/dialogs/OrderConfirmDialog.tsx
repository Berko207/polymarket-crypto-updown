import { formatPercent } from '@/lib/polymarket'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { OutcomeSide } from '@/components/common/OutcomeBadge'

export interface OrderConfirm {
  side: 'BUY' | 'SELL'
  outcome: OutcomeSide
  coinSymbol: string
  price: number
  size: number
  estCost: number
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex justify-between text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('font-medium', warn && 'text-down')}>{value}</dd>
    </div>
  )
}

export function OrderConfirmDialog({
  confirm,
  usdcBalance,
  pending,
  onConfirm,
  onOpenChange,
}: {
  confirm: OrderConfirm | null
  usdcBalance?: number
  pending?: boolean
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}) {
  const selling = confirm?.side === 'SELL'
  const insufficient =
    confirm != null && !selling && usdcBalance != null && confirm.estCost > usdcBalance

  return (
    <Dialog open={confirm != null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        {confirm && (
          <>
            <DialogHeader>
              <DialogTitle>{selling ? 'Confirm sell' : 'Confirm order'}</DialogTitle>
              <DialogDescription>
                {confirm.coinSymbol} · {confirm.outcome === 'up' ? 'Up' : 'Down'} —{' '}
                {selling ? 'market sell' : 'market buy'}
              </DialogDescription>
            </DialogHeader>

            <dl className="grid gap-2">
              <Stat label="Est. price" value={formatPercent(confirm.price)} />
              <Stat
                label="Shares"
                value={confirm.size < 10 ? confirm.size.toFixed(2) : confirm.size.toFixed(1)}
              />
              <Stat
                label={selling ? 'Est. proceeds' : 'Est. cost'}
                value={`$${confirm.estCost.toFixed(2)}`}
                warn={insufficient}
              />
              {!selling && usdcBalance != null && (
                <Stat label="USDC balance" value={`$${usdcBalance.toFixed(2)}`} />
              )}
            </dl>

            {insufficient && (
              <p className="text-sm text-down">Insufficient USDC for this order.</p>
            )}

            <DialogFooter>
              <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
                Cancel
              </Button>
              <Button
                onClick={onConfirm}
                disabled={insufficient || pending}
                className={cn(
                  'text-white',
                  confirm.outcome === 'up' ? 'bg-up hover:bg-up/90' : 'bg-down hover:bg-down/90',
                )}
              >
                {pending ? 'Submitting…' : selling ? 'Sell' : 'Place order'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
