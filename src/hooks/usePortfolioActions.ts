import { useState } from 'react'
import { useOrderActions } from './useOrderActions'
import { coinSymbolFromPosition } from '@/lib/marketLabels'
import { outcomeSide } from '@/components/common/OutcomeBadge'
import type { OrderConfirm } from '@/components/dialogs/OrderConfirmDialog'
import type { Position } from '@/lib/api'

export interface PendingSell {
  confirm: OrderConfirm
  tokenId: string
  label: string
}

/** Sell-with-confirmation flow for the portfolio panel. */
export function useSellFlow() {
  const actions = useOrderActions()
  const [sellingId, setSellingId] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingSell | null>(null)

  const request = (position: Position, sellPrice: number, symbol?: string) => {
    const side = outcomeSide(position.outcome)
    const coinSymbol = symbol ?? coinSymbolFromPosition(position)
    setPending({
      tokenId: position.tokenId,
      label: `${coinSymbol} ${side === 'up' ? 'Up' : 'Down'}`,
      confirm: {
        side: 'SELL',
        outcome: side,
        coinSymbol,
        price: sellPrice,
        size: position.size,
        estCost: sellPrice * position.size,
      },
    })
  }

  const submit = async () => {
    if (!pending) return
    const { tokenId, confirm, label } = pending
    setPending(null)
    setSellingId(tokenId)
    try {
      await actions.sell({ tokenId, size: confirm.size, label })
    } catch {
      // toast surfaced in useOrderActions
    } finally {
      setSellingId(null)
    }
  }

  return { pending, sellingId, request, submit, close: () => setPending(null), placing: actions.isPlacing }
}

/** Cancel-an-open-order flow with per-row pending state. */
export function useCancelFlow() {
  const actions = useOrderActions()
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const cancel = async (orderId: string) => {
    setCancellingId(orderId)
    try {
      await actions.cancel(orderId)
    } catch {
      // toast surfaced in useOrderActions
    } finally {
      setCancellingId(null)
    }
  }

  return { cancellingId, cancel }
}
