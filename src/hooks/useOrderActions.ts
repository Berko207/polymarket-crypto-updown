import { toast } from 'sonner'
import { usePlaceOrder, useCancelOrder } from '@/queries/portfolio'
import { formatCents } from '@/lib/polymarket'
import type { PlaceOrderFillMeta, PlaceOrderResponse } from '@/lib/api'

const ERROR_TOAST_MS = 15_000

function idSuffix(result: PlaceOrderResponse): string {
  return result.orderId ? ` · ${result.orderId.slice(0, 8)}…` : ''
}

function errText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}

function fillSummary(
  result: PlaceOrderResponse,
  opts: { price?: number; amountUsd?: number; size?: number },
): string {
  const price = result.fillPrice ?? opts.price
  const size =
    result.fillSize ??
    (opts.amountUsd != null && price != null && price > 0
      ? opts.amountUsd / price
      : opts.size)
  const parts: string[] = []
  if (price != null && price > 0) parts.push(`@ ${formatCents(price)}`)
  if (size != null && size > 0) parts.push(`${size.toFixed(2)} sh`)
  return parts.length ? ` · ${parts.join(' · ')}` : ''
}

/**
 * Single place for buy / sell / cancel order side-effects (toasts + cache
 * invalidation), replacing the duplicated placeOrder calls that lived inside
 * OpenOrders and MarketHoldings.
 */
export function useOrderActions() {
  const place = usePlaceOrder()
  const cancelMut = useCancelOrder()

  const buy = async (opts: {
    tokenId: string
    amountUsd: number
    label: string
    price?: number
    tickSize?: number
    negRisk?: boolean
    fillMeta?: PlaceOrderFillMeta
  }) => {
    const id = toast.loading(`Buying ${opts.label}…`)
    try {
      const result = await place.mutateAsync({
        tokenId: opts.tokenId,
        side: 'BUY',
        orderType: 'market',
        amount: opts.amountUsd,
        price: opts.price,
        tickSize: opts.tickSize,
        negRisk: opts.negRisk,
        fillMeta: opts.fillMeta,
      })
      const status = (result.status ?? '').toLowerCase()
      const fill = fillSummary(result, { price: opts.price, amountUsd: opts.amountUsd })
      if (status === 'unmatched') {
        toast.error(`Buy ${opts.label} didn't fill — no liquidity at current price`, {
          id,
          duration: ERROR_TOAST_MS,
        })
      } else if (status === 'delayed') {
        toast.success(`Buy ${opts.label} matching…${fill}${idSuffix(result)}`, { id })
      } else {
        toast.success(`Buy ${opts.label} filled${fill}${idSuffix(result)}`, { id })
      }
      return result
    } catch (e) {
      toast.error(errText(e, 'Order failed'), { id, duration: ERROR_TOAST_MS })
      throw e
    }
  }

  const sell = async (opts: {
    tokenId: string
    size: number
    label: string
    /** Live best bid — lets the server skip a CLOB book-walk round trip (faster fill). */
    price?: number
    tickSize?: number
    negRisk?: boolean
    fillMeta?: PlaceOrderFillMeta
  }) => {
    const id = toast.loading(`Selling ${opts.label}…`)
    try {
      const result = await place.mutateAsync({
        tokenId: opts.tokenId,
        side: 'SELL',
        orderType: 'market',
        size: opts.size,
        price: opts.price,
        tickSize: opts.tickSize,
        negRisk: opts.negRisk,
        fillMeta: opts.fillMeta,
      })
      const status = (result.status ?? '').toLowerCase()
      const fill = fillSummary(result, { price: opts.price, size: opts.size })
      if (status === 'unmatched') {
        toast.error(`Sell ${opts.label} didn't fill — no bids on the book`, {
          id,
          duration: ERROR_TOAST_MS,
        })
      } else if (status === 'delayed') {
        toast.success(`Sell ${opts.label} matching…${fill}${idSuffix(result)}`, { id })
      } else {
        toast.success(`Sell ${opts.label} filled${fill}${idSuffix(result)}`, { id })
      }
      return result
    } catch (e) {
      toast.error(errText(e, 'Sell failed'), { id, duration: ERROR_TOAST_MS })
      throw e
    }
  }

  const cancel = async (orderId: string) => {
    const id = toast.loading('Cancelling order…')
    try {
      await cancelMut.mutateAsync(orderId)
      toast.success('Order cancelled', { id })
    } catch (e) {
      toast.error(errText(e, 'Cancel failed'), { id, duration: ERROR_TOAST_MS })
      throw e
    }
  }

  return { buy, sell, cancel, isPlacing: place.isPending, isCancelling: cancelMut.isPending }
}
