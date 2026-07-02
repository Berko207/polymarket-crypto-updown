import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { coinSymbolFromPosition } from '@/lib/marketLabels'
import { outcomeSide } from '@/components/common/OutcomeBadge'
import type { TokenQuoteMap } from '@/lib/clobSocket'
import type { PlaceOrderResponse, Position } from '@/lib/api'

/** How long to keep watching for a bid before giving up. */
const AUTO_WINDOW_MS = 45_000
/** Min gap between retry attempts per token — keeps us well under the server rate limit. */
const RETRY_COOLDOWN_MS = 3_000

type SellFn = (
  position: Position,
  price: number,
  symbol?: string,
  marketTokens?: { upTokenId: string | null; downTokenId: string | null },
) => Promise<PlaceOrderResponse | undefined>

interface ArmedEntry {
  deadline: number
  label: string
}

function positionLabel(position: Position): string {
  const side = outcomeSide(position.outcome)
  return `${coinSymbolFromPosition(position)} ${side === 'up' ? 'Up' : 'Down'}`
}

/**
 * "Sell the moment a bid shows up." When a market sell finds an empty book, arm the token:
 * we watch the shared live-quote stream and re-fire the market sell as soon as a bid appears,
 * retrying (rate-limit-friendly) until it fills or the window expires. The operator can cancel
 * from the toast. Reuses the socket the portfolio already subscribes — no extra connection.
 */
export function useAutoSell({
  positions,
  quotes,
  tokenPairById,
  sell,
}: {
  positions: Position[]
  quotes: TokenQuoteMap
  tokenPairById: Map<string, { upTokenId: string | null; downTokenId: string | null }>
  sell: SellFn
}) {
  const [armed, setArmed] = useState<Record<string, ArmedEntry>>({})
  const toastIds = useRef<Record<string, string | number>>({})
  const lastAttempt = useRef<Record<string, number>>({})
  const firing = useRef<Set<string>>(new Set())

  // Keep mutable deps out of the watcher effect so it only re-runs on quote/position/arm changes.
  const sellRef = useRef(sell)
  sellRef.current = sell
  const pairRef = useRef(tokenPairById)
  pairRef.current = tokenPairById
  const positionsRef = useRef(positions)
  positionsRef.current = positions

  const disarm = useCallback(
    (tokenId: string, finalToast?: { type: 'error' | 'dismiss'; message?: string }) => {
      const tid = toastIds.current[tokenId]
      if (tid != null) {
        if (finalToast?.type === 'error') toast.error(finalToast.message ?? '', { id: tid, duration: 6_000 })
        else toast.dismiss(tid)
        delete toastIds.current[tokenId]
      }
      delete lastAttempt.current[tokenId]
      firing.current.delete(tokenId)
      setArmed((prev) => {
        if (!(tokenId in prev)) return prev
        const next = { ...prev }
        delete next[tokenId]
        return next
      })
    },
    [],
  )

  /** Start watching for a bid to sell this position into. */
  const arm = useCallback(
    (position: Position) => {
      const label = positionLabel(position)
      toastIds.current[position.tokenId] = toast.loading(`Waiting for a bid to sell ${label}…`, {
        duration: Infinity,
        cancel: { label: 'Cancel', onClick: () => disarm(position.tokenId, { type: 'dismiss' }) },
      })
      lastAttempt.current[position.tokenId] = Date.now()
      setArmed((prev) => ({ ...prev, [position.tokenId]: { deadline: Date.now() + AUTO_WINDOW_MS, label } }))
    },
    [disarm],
  )

  useEffect(() => {
    if (Object.keys(armed).length === 0) return
    const now = Date.now()
    for (const [tokenId, entry] of Object.entries(armed)) {
      if (now > entry.deadline) {
        disarm(tokenId, { type: 'error', message: `Gave up waiting for a bid to sell ${entry.label}` })
        continue
      }
      const position = positionsRef.current.find((p) => p.tokenId === tokenId)
      if (!position) {
        // Position is gone (it sold, or resolved) — nothing left to do.
        disarm(tokenId, { type: 'dismiss' })
        continue
      }
      const bid = quotes[tokenId]?.bestBid
      if (bid == null || bid <= 0) continue
      if (firing.current.has(tokenId)) continue
      if (now - (lastAttempt.current[tokenId] ?? 0) < RETRY_COOLDOWN_MS) continue

      firing.current.add(tokenId)
      lastAttempt.current[tokenId] = now
      void sellRef.current(position, bid, undefined, pairRef.current.get(tokenId)).then((result) => {
        firing.current.delete(tokenId)
        const status = (result?.status ?? '').toLowerCase()
        // Anything other than a fresh empty book means we're done (filled / matching / gone).
        if (result && status !== 'unmatched') disarm(tokenId, { type: 'dismiss' })
      })
    }
    // Re-check whenever a quote ticks or the armed set changes; also re-arm the deadline sweep.
    const timer = setTimeout(() => setArmed((prev) => ({ ...prev })), RETRY_COOLDOWN_MS)
    return () => clearTimeout(timer)
  }, [armed, quotes, disarm])

  return { arm }
}
