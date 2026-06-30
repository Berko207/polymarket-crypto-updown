import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  cancelOrder,
  fetchOpenOrders,
  fetchPositions,
  placeOrder,
  type PlaceOrderRequest,
  type Position,
} from '@/lib/api'
import { qk } from './keys'
import type { TimeframeId } from '@/lib/types'

const PORTFOLIO_POLL_MS = 3_000

/** Match Polymarket Data API dust threshold — below this, hide the row. */
export const MIN_POSITION_SIZE = 0.01

export function isMeaningfulPosition(p: Position): boolean {
  return p.size >= MIN_POSITION_SIZE && !p.redeemable
}

export interface FocusedMarketMeta {
  eventSlug: string
  title: string
  timeframe: TimeframeId
}

function enrichInstantPosition(p: Position, meta: FocusedMarketMeta): Position {
  return {
    ...p,
    eventSlug: p.eventSlug || meta.eventSlug,
    title: p.title === 'This market' || !p.title.trim() ? meta.title : p.title,
  }
}

/** Live crypto up/down positions only (drops dust, resolved, and zero-price rows). */
function isCryptoUpDown(title: string): boolean {
  return title.toLowerCase().includes('up or down')
}
export function filterPositions(rows: Position[]): Position[] {
  return rows.filter(
    (p) =>
      isCryptoUpDown(p.title) &&
      isMeaningfulPosition(p) &&
      p.currentPrice > 0,
  )
}

export function useOrdersQuery(enabled: boolean) {
  return useQuery({
    queryKey: qk.orders,
    queryFn: fetchOpenOrders,
    enabled,
    refetchInterval: PORTFOLIO_POLL_MS,
  })
}

export function usePositionsQuery(enabled: boolean) {
  return useQuery({
    queryKey: qk.positions,
    queryFn: () => fetchPositions(),
    enabled,
    refetchInterval: PORTFOLIO_POLL_MS,
    select: filterPositions,
  })
}

/**
 * Overlay the focused market's instant on-chain holdings onto the Data-API global
 * list so a fill shows immediately, before the Data API indexes it.
 *
 * `focusedTokenIds` are the tokens the instant (on-chain balance) path actually
 * checked. For those, the chain is authoritative: we drop the (possibly stale)
 * Data-API rows and re-add only what the instant path returned — so a buy/partial
 * sell shows the right size at once, and a full sell disappears instead of lingering.
 * Pass `[]` while the instant query is still loading to avoid hiding a real position.
 */
export function mergeInstantHoldings(
  global: Position[],
  instant: Position[],
  focusedTokenIds: string[] = [],
  focusedMarket?: FocusedMarketMeta | null,
): Position[] {
  const focused = new Set(focusedTokenIds)
  const byToken = new Map(global.filter((p) => !focused.has(p.tokenId)).map((p) => [p.tokenId, p]))
  for (const raw of instant) {
    if (!isMeaningfulPosition(raw)) continue
    const p =
      focusedMarket && focused.has(raw.tokenId)
        ? enrichInstantPosition(raw, focusedMarket)
        : raw
    byToken.set(p.tokenId, p)
  }
  return [...byToken.values()]
}

/**
 * Holdings for ONE market via the upToken/downToken path, which merges live CLOB
 * token balances — so a freshly-filled position shows immediately, before the
 * Data API (used by {@link usePositionsQuery}) indexes it. Keyed under
 * `['positions', …]` so the place-order mutation's invalidation refreshes it too.
 */
export function useMarketHoldingsQuery(
  upTokenId: string | null,
  downTokenId: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['positions', 'market', upTokenId ?? '', downTokenId ?? ''],
    queryFn: () => fetchPositions({ upTokenId, downTokenId }),
    enabled: enabled && Boolean(upTokenId || downTokenId),
    refetchInterval: PORTFOLIO_POLL_MS,
    select: (rows) => rows.filter(isMeaningfulPosition),
  })
}

/** Place a market/limit BUY or SELL; refresh orders + positions + account on success. */
export function usePlaceOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: PlaceOrderRequest) => placeOrder(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.orders, refetchType: 'none' })
      void qc.invalidateQueries({ queryKey: qk.positions, refetchType: 'none' })
      void qc.invalidateQueries({ queryKey: qk.account, refetchType: 'none' })
      // Stagger refetches so the next click isn't blocked behind portfolio polling.
      setTimeout(() => {
        void qc.refetchQueries({ queryKey: qk.orders })
        void qc.refetchQueries({ queryKey: qk.positions })
        void qc.refetchQueries({ queryKey: qk.account })
      }, 400)
    },
  })
}

export function useCancelOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (orderId: string) => cancelOrder(orderId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.orders })
      void qc.invalidateQueries({ queryKey: qk.account })
    },
  })
}
