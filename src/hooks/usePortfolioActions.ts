import { useState } from 'react'
import { useOrderActions } from './useOrderActions'
import { coinSymbolFromPosition, positionTimeframe } from '@/lib/marketLabels'
import { timeframeFromEventSlug } from '@/lib/slugs'
import type { TimeframeId } from '@/lib/types'
import { outcomeSide } from '@/components/common/OutcomeBadge'
import type { Position } from '@/lib/api'

/** One-click market sell for the portfolio panel. */
export function useSellFlow() {
  const actions = useOrderActions()
  const [sellingId, setSellingId] = useState<string | null>(null)

  const sell = async (
    position: Position,
    sellPrice: number,
    symbol?: string,
    marketTokens?: { upTokenId: string | null; downTokenId: string | null },
  ) => {
    const side = outcomeSide(position.outcome)
    const coinSymbol = symbol ?? coinSymbolFromPosition(position)
    const label = `${coinSymbol} ${side === 'up' ? 'Up' : 'Down'}`
    setSellingId(position.tokenId)
    try {
      const tf: TimeframeId =
        positionTimeframe(position) ?? timeframeFromEventSlug(position.eventSlug) ?? '5m'
      await actions.sell({
        tokenId: position.tokenId,
        size: position.size,
        label,
        price: sellPrice,
        fillMeta: {
          outcome: position.outcome,
          eventSlug: position.eventSlug,
          title: position.title,
          timeframe: tf,
          upTokenId: marketTokens?.upTokenId ?? null,
          downTokenId: marketTokens?.downTokenId ?? null,
        },
      })
    } catch {
      // toast surfaced in useOrderActions
    } finally {
      setSellingId(null)
    }
  }

  return { sellingId, sell, placing: actions.isPlacing }
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
