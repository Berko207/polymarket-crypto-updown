import { useMemo } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  cancelOrder,
  fetchOpenOrders,
  fetchPositions,
  placeOrder,
  type PlaceOrderRequest,
  type PlaceOrderResponse,
  type Position,
} from '@/lib/api'
import { recentFillPrice, recentFillSize, hasRecentFill, rememberRecentFill, rememberRecentSell, clearRecentFill, clearRecentSell, recentFillPositions, isRecentlySold } from '@/lib/recentFills'
import { timeframeFromEventSlug } from '@/lib/slugs'
import { getTokenMarketLabel } from '@/lib/tokenLabels'
import { qk } from './keys'
import type { TimeframeId } from '@/lib/types'

const PORTFOLIO_POLL_MS = 3_000
const HOLDINGS_POLL_MS = 1_500

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

/** Chain size is authoritative; cost metadata comes from the indexed Data API row when
 * the instant path hasn't caught up yet (common right after a fill). */
export function mergeInstantWithIndexed(instant: Position, indexed?: Position): Position {
  if (!indexed) {
    const fillPrice = recentFillPrice(instant.tokenId)
    const fillSize = recentFillSize(instant.tokenId)
    const size =
      instant.size >= MIN_POSITION_SIZE
        ? instant.size
        : fillSize != null && fillSize >= MIN_POSITION_SIZE
          ? fillSize
          : instant.size
    if (fillPrice && (instant.avgPrice <= 0 || size > instant.size)) {
      const avgPrice = instant.avgPrice > 0 ? instant.avgPrice : fillPrice
      return {
        ...instant,
        size,
        avgPrice,
        initialValue: size * avgPrice,
      }
    }
    return instant
  }

  const avgPrice =
    instant.avgPrice > 0
      ? instant.avgPrice
      : indexed.avgPrice > 0
        ? indexed.avgPrice
        : indexed.initialValue != null && indexed.initialValue > 0 && indexed.size > 0
          ? indexed.initialValue / indexed.size
          : recentFillPrice(instant.tokenId) ?? 0

  const initialValue =
    avgPrice > 0
      ? instant.size * avgPrice
      : indexed.initialValue != null && indexed.initialValue > 0 && indexed.size > 0
        ? (indexed.initialValue / indexed.size) * instant.size
        : instant.initialValue

  return {
    ...instant,
    avgPrice,
    initialValue,
    currentPrice: instant.currentPrice > 0 ? instant.currentPrice : indexed.currentPrice,
    outcome: instant.outcome !== '—' && instant.outcome ? instant.outcome : indexed.outcome,
    title: instant.title === 'This market' || !instant.title.trim() ? indexed.title : instant.title,
    eventSlug: instant.eventSlug || indexed.eventSlug,
  }
}

function enrichFromMeta(p: Position, meta?: FocusedMarketMeta): Position {
  if (!meta) return p
  const enriched = enrichInstantPosition(p, meta)
  // Instant chain rows often lack slug/title — keep timeframe tab routing working.
  if (!enriched.eventSlug && meta.eventSlug) {
    return { ...enriched, eventSlug: meta.eventSlug }
  }
  return enriched
}

/** Live crypto up/down positions only (drops dust, resolved, and zero-price rows). */
function isCryptoUpDown(p: Position): boolean {
  if (p.title.toLowerCase().includes('up or down')) return true
  if (p.eventSlug && timeframeFromEventSlug(p.eventSlug)) return true
  if (getTokenMarketLabel(p.tokenId)) return true
  return false
}
export function filterPositions(rows: Position[]): Position[] {
  return rows.filter((p) => isCryptoUpDown(p) && isMeaningfulPosition(p))
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
  authoritativeTokenIds: string[] = [],
  marketMetaByToken?: Map<string, FocusedMarketMeta>,
): Position[] {
  const authoritative = new Set(authoritativeTokenIds)
  const globalByToken = new Map(global.map((p) => [p.tokenId, p]))
  const byToken = new Map(
    global
      .filter((p) => !authoritative.has(p.tokenId))
      .map((p) => [p.tokenId, enrichFromMeta(p, marketMetaByToken?.get(p.tokenId))]),
  )
  for (const raw of instant) {
    if (isRecentlySold(raw.tokenId)) continue
    if (!isMeaningfulPosition(raw)) continue
    let p = authoritative.has(raw.tokenId)
      ? mergeInstantWithIndexed(raw, globalByToken.get(raw.tokenId))
      : raw
    const meta = marketMetaByToken?.get(raw.tokenId)
    if (meta) p = enrichFromMeta(p, meta)
    byToken.set(p.tokenId, p)
  }
  return [...byToken.values()]
}

/** Drop rows hidden by an in-flight sell (chain balance can lag). */
export function filterRecentlySoldPositions(positions: Position[]): Position[] {
  return positions.filter((p) => !isRecentlySold(p.tokenId))
}

/** Overlay in-flight fills (chain often lags 1–3s behind a market buy). */
export function mergePendingFillPositions(positions: Position[]): Position[] {
  const byToken = new Map(positions.map((p) => [p.tokenId, p]))
  for (const pending of recentFillPositions()) {
    const existing = byToken.get(pending.tokenId)
    if (!existing) {
      byToken.set(pending.tokenId, pending)
      continue
    }
    if (existing.size < pending.size || existing.avgPrice <= 0) {
      const size = Math.max(existing.size, pending.size)
      const avgPrice = existing.avgPrice > 0 ? existing.avgPrice : pending.avgPrice
      byToken.set(pending.tokenId, {
        ...existing,
        size,
        avgPrice,
        initialValue: size * avgPrice,
        title: existing.title === 'This market' || !existing.title.trim() ? pending.title : existing.title,
        eventSlug: existing.eventSlug || pending.eventSlug,
        outcome: existing.outcome === '—' ? pending.outcome : existing.outcome,
      })
    }
  }
  return [...byToken.values()]
}

/**
 * On-chain holdings for every watchlist market in a timeframe — so a fill in any
 * coin shows immediately without selecting that coin first.
 */
export function useTimeframeHoldingsQuery(
  markets: {
    upTokenId: string | null
    downTokenId: string | null
    meta: FocusedMarketMeta
  }[],
  enabled: boolean,
) {
  const results = useQueries({
    queries: markets.map((m) => ({
      queryKey: ['positions', 'market', m.upTokenId ?? '', m.downTokenId ?? ''],
      queryFn: () =>
        fetchPositions({ upTokenId: m.upTokenId ?? undefined, downTokenId: m.downTokenId ?? undefined }),
      enabled: enabled && Boolean(m.upTokenId || m.downTokenId),
      refetchInterval: HOLDINGS_POLL_MS,
      staleTime: 0,
      select: (rows: Position[]) => rows.filter(isMeaningfulPosition),
    })),
  })

  const instant = useMemo(() => results.flatMap((r) => r.data ?? []), [results])

  const authoritativeTokenIds = useMemo(() => {
    const ids: string[] = []
    markets.forEach((m, i) => {
      if (results[i].data === undefined) return
      if (m.upTokenId && !hasRecentFill(m.upTokenId)) ids.push(m.upTokenId)
      if (m.downTokenId && !hasRecentFill(m.downTokenId)) ids.push(m.downTokenId)
    })
    return ids
  }, [markets, results])

  return { instant, authoritativeTokenIds }
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

function refetchPortfolio(qc: ReturnType<typeof useQueryClient>) {
  void qc.refetchQueries({ queryKey: qk.orders })
  void qc.refetchQueries({ queryKey: qk.positions })
  void qc.refetchQueries({ queryKey: ['positions', 'market'] })
  void qc.refetchQueries({ queryKey: qk.account })
}

const REFETCH_AFTER_FILL_MS = [0, 100, 250, 500, 1_000, 2_000, 4_000] as const

function schedulePortfolioRefetches(qc: ReturnType<typeof useQueryClient>) {
  for (const delay of REFETCH_AFTER_FILL_MS) {
    if (delay === 0) refetchPortfolio(qc)
    else setTimeout(() => refetchPortfolio(qc), delay)
  }
}

interface ResolvedFill {
  price: number
  size: number
}

function resolveFillFromRequest(body: PlaceOrderRequest): ResolvedFill | null {
  if (body.side === 'SELL' && body.size != null && body.size > 0) {
    const price =
      body.price != null && body.price > 0 && body.price < 1 ? body.price : 0.5
    return { price, size: body.size }
  }
  const price = body.price != null && body.price > 0 && body.price < 1 ? body.price : undefined
  const size =
    body.side === 'BUY' && body.amount != null && price != null ? body.amount / price : undefined
  if (price == null || size == null || !(size > 0)) return null
  return { price, size }
}

function resolveFill(body: PlaceOrderRequest, result: PlaceOrderResponse): ResolvedFill | null {
  const price =
    result.fillPrice ??
    (body.price != null && body.price > 0 && body.price < 1 ? body.price : undefined)
  const size =
    result.fillSize ??
    (body.side === 'BUY' && body.amount != null && price != null && price > 0
      ? body.amount / price
      : body.side === 'SELL' && body.size != null && body.size > 0
        ? body.size
        : undefined)
  if (price == null || size == null || !(price > 0 && price < 1) || !(size > 0)) return null
  return { price, size }
}

function mergeBuyIntoPosition(
  existing: Position | undefined,
  fill: ResolvedFill,
  tokenId: string,
  meta?: PlaceOrderRequest['fillMeta'],
): Position {
  const priorSize = existing?.size ?? 0
  const priorAvg = existing?.avgPrice ?? 0
  const size = priorSize > 0 ? priorSize + fill.size : fill.size
  const avgPrice =
    priorSize > 0 && priorAvg > 0
      ? (priorSize * priorAvg + fill.size * fill.price) / size
      : fill.price

  return {
    tokenId,
    outcome: existing?.outcome && existing.outcome !== '—' ? existing.outcome : meta?.outcome ?? '—',
    size,
    avgPrice,
    currentPrice: existing?.currentPrice ?? fill.price,
    initialValue: size * avgPrice,
    title: existing?.title && existing.title !== 'This market' ? existing.title : meta?.title ?? 'This market',
    eventSlug: existing?.eventSlug || meta?.eventSlug || '',
    redeemable: existing?.redeemable ?? false,
  }
}

function patchRows(
  rows: Position[],
  tokenId: string,
  side: 'BUY' | 'SELL',
  fill: ResolvedFill,
  meta?: PlaceOrderRequest['fillMeta'],
): Position[] {
  const existing = rows.find((p) => p.tokenId === tokenId)

  if (side === 'SELL') {
    if (!existing) return rows
    const size = Math.max(0, existing.size - fill.size)
    if (size < MIN_POSITION_SIZE) return rows.filter((p) => p.tokenId !== tokenId)
    return rows.map((p) =>
      p.tokenId === tokenId ? { ...p, size, initialValue: size * (p.avgPrice || fill.price) } : p,
    )
  }

  const next = mergeBuyIntoPosition(existing, fill, tokenId, meta)
  if (existing) return rows.map((p) => (p.tokenId === tokenId ? next : p))
  return [...rows, next]
}

/** Patch holdings cache so a fill shows before chain/Data API catch up. */
function patchMarketHoldingsCache(
  qc: ReturnType<typeof useQueryClient>,
  tokenId: string,
  side: 'BUY' | 'SELL',
  fill: ResolvedFill,
  meta?: PlaceOrderRequest['fillMeta'],
) {
  const patch = (old: Position[] | undefined) => patchRows(old ?? [], tokenId, side, fill, meta)

  qc.setQueriesData<Position[]>({ queryKey: ['positions', 'market'] }, patch)

  if (meta?.upTokenId || meta?.downTokenId) {
    const key = ['positions', 'market', meta.upTokenId ?? '', meta.downTokenId ?? ''] as const
    qc.setQueryData<Position[]>(key, patch(qc.getQueryData<Position[]>(key)))
  }
}

function patchGlobalPositionsCache(
  qc: ReturnType<typeof useQueryClient>,
  tokenId: string,
  side: 'BUY' | 'SELL',
  fill: ResolvedFill,
  meta?: PlaceOrderRequest['fillMeta'],
) {
  qc.setQueryData<Position[]>(qk.positions, (old) =>
    patchRows(old ?? [], tokenId, side, fill, meta),
  )
}

function applyFillOptimistic(
  qc: ReturnType<typeof useQueryClient>,
  body: PlaceOrderRequest,
  fill: ResolvedFill,
) {
  if (body.side === 'BUY') {
    rememberRecentFill(body.tokenId, fill.price, fill.size, body.fillMeta)
  } else {
    rememberRecentSell(body.tokenId)
  }
  patchMarketHoldingsCache(qc, body.tokenId, body.side, fill, body.fillMeta)
  patchGlobalPositionsCache(qc, body.tokenId, body.side, fill, body.fillMeta)
}

interface FillRollbackSnapshot {
  global: Position[] | undefined
  markets: [readonly unknown[], Position[] | undefined][]
}

function captureFillSnapshot(qc: ReturnType<typeof useQueryClient>): FillRollbackSnapshot {
  return {
    global: qc.getQueryData<Position[]>(qk.positions),
    markets: qc.getQueriesData<Position[]>({ queryKey: ['positions', 'market'] }),
  }
}

function rollbackFillOptimistic(
  qc: ReturnType<typeof useQueryClient>,
  snapshot: FillRollbackSnapshot,
  body: PlaceOrderRequest,
) {
  if (body.side === 'SELL') clearRecentSell(body.tokenId)
  else clearRecentFill(body.tokenId)
  qc.setQueryData(qk.positions, snapshot.global)
  for (const [key, data] of snapshot.markets) {
    qc.setQueryData(key, data)
  }
}

/** True when a market sell fully closed the position (not unmatched / partial zero-fill). */
function isFullSellFill(body: PlaceOrderRequest, fill: ResolvedFill, filled: boolean): boolean {
  if (body.side !== 'SELL' || !filled) return false
  const sold = fill.size
  const held = body.size ?? sold
  return sold >= held - 1e-6
}

/** Place a market/limit BUY or SELL; refresh orders + positions + account on success. */
export function usePlaceOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: PlaceOrderRequest) => placeOrder(body),
    onMutate: (body) => {
      const estimate = resolveFillFromRequest(body)
      if (!estimate) return undefined
      const snapshot = captureFillSnapshot(qc)
      applyFillOptimistic(qc, body, estimate)
      return snapshot
    },
    onSuccess: (data, body, snapshot) => {
      const fill = resolveFill(body, data) ?? resolveFillFromRequest(body)
      const status = (data.status ?? '').toLowerCase()
      const filled = status !== 'unmatched' && status !== 'rejected'

      if (!filled) {
        if (snapshot) rollbackFillOptimistic(qc, snapshot, body)
      } else if (fill) {
        if (body.side === 'BUY') {
          rememberRecentFill(body.tokenId, fill.price, fill.size, body.fillMeta)
          patchMarketHoldingsCache(qc, body.tokenId, body.side, fill, body.fillMeta)
          patchGlobalPositionsCache(qc, body.tokenId, body.side, fill, body.fillMeta)
        } else if (isFullSellFill(body, fill, filled)) {
          rememberRecentSell(body.tokenId)
          patchMarketHoldingsCache(qc, body.tokenId, body.side, fill, body.fillMeta)
          patchGlobalPositionsCache(qc, body.tokenId, body.side, fill, body.fillMeta)
        } else {
          // Partial sell — show reduced size, don't hide the row.
          clearRecentSell(body.tokenId)
          if (snapshot) rollbackFillOptimistic(qc, snapshot, body)
          patchMarketHoldingsCache(qc, body.tokenId, 'SELL', fill, body.fillMeta)
          patchGlobalPositionsCache(qc, body.tokenId, 'SELL', fill, body.fillMeta)
        }
      }

      void qc.invalidateQueries({ queryKey: qk.orders, refetchType: 'none' })
      void qc.invalidateQueries({ queryKey: qk.positions, refetchType: 'none' })
      void qc.invalidateQueries({ queryKey: ['positions', 'market'], refetchType: 'none' })
      void qc.invalidateQueries({ queryKey: qk.account, refetchType: 'none' })
      schedulePortfolioRefetches(qc)
    },
    onError: (_error, body, snapshot) => {
      if (snapshot) rollbackFillOptimistic(qc, snapshot, body)
      schedulePortfolioRefetches(qc)
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
