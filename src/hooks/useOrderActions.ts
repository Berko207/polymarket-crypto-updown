import { toast } from 'sonner'
import { usePlaceOrder, useCancelOrder } from '@/queries/portfolio'
import type { PlaceOrderResponse } from '@/lib/api'

function idSuffix(result: PlaceOrderResponse): string {
  return result.orderId ? ` · ${result.orderId.slice(0, 8)}…` : ''
}

function errText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}

/**
 * Single place for buy / sell / cancel order side-effects (toasts + cache
 * invalidation), replacing the duplicated placeOrder calls that lived inside
 * OpenOrders and MarketHoldings.
 */
export function useOrderActions() {
  const place = usePlaceOrder()
  const cancelMut = useCancelOrder()

  const buy = async (opts: { tokenId: string; amountUsd: number; label: string }) => {
    const id = toast.loading(`Buying ${opts.label}…`)
    try {
      const result = await place.mutateAsync({
        tokenId: opts.tokenId,
        side: 'BUY',
        orderType: 'market',
        amount: opts.amountUsd,
      })
      const status = (result.status ?? '').toLowerCase()
      if (status === 'unmatched') {
        toast.error(`Buy ${opts.label} didn't fill — book moved, try again`, { id })
      } else if (status === 'delayed') {
        toast.success(`Buy ${opts.label} matching…${idSuffix(result)}`, { id })
      } else {
        toast.success(`Buy ${opts.label} filled${idSuffix(result)}`, { id })
      }
      return result
    } catch (e) {
      toast.error(errText(e, 'Order failed'), { id })
      throw e
    }
  }

  const sell = async (opts: { tokenId: string; size: number; label: string }) => {
    const id = toast.loading(`Selling ${opts.label}…`)
    try {
      const result = await place.mutateAsync({
        tokenId: opts.tokenId,
        side: 'SELL',
        orderType: 'market',
        size: opts.size,
      })
      toast.success(`Sell ${opts.label} submitted${idSuffix(result)}`, { id })
      return result
    } catch (e) {
      toast.error(errText(e, 'Sell failed'), { id })
      throw e
    }
  }

  const cancel = async (orderId: string) => {
    const id = toast.loading('Cancelling order…')
    try {
      await cancelMut.mutateAsync(orderId)
      toast.success('Order cancelled', { id })
    } catch (e) {
      toast.error(errText(e, 'Cancel failed'), { id })
      throw e
    }
  }

  return { buy, sell, cancel, isPlacing: place.isPending, isCancelling: cancelMut.isPending }
}
