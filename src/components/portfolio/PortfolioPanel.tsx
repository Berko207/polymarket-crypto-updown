import { useMemo, useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import {
  filterRecentlySoldPositions,
  mergeInstantHoldings,
  mergePendingFillPositions,
  useOrdersQuery,
  usePositionsQuery,
  useResolvedPositionsQuery,
  useTimeframeHoldingsQuery,
} from '@/queries/portfolio'
import { useWatchlistQuery } from '@/queries/market'
import { useRecentFillVersion } from '@/hooks/useRecentFillVersion'
import { useNow } from '@/hooks/useNow'
import { useSellFlow, useCancelFlow } from '@/hooks/usePortfolioActions'
import { useTokenQuotes } from '@/hooks/useTokenQuotes'
import { useUpdateConfig } from '@/store/ui'
import { getTimeframe } from '@/lib/config'
import {
  filterPositionsByTimeframe,
  formatPositionLabel,
  groupPositionsByCoin,
} from '@/lib/marketLabels'
import { formatPnlPct, formatPnlUsd } from '@/lib/positionPnl'
import {
  buildPositionLeg,
  recommendSellFirst,
  summarizePair,
} from '@/lib/sellPriority'
import { cn } from '@/lib/utils'
import { ExportHistoryButton } from './ExportHistoryButton'
import { OrderRow } from './OrderRow'
import { PositionRow } from './PositionRow'
import { TradeHistory } from './TradeHistory'
import { outcomeSide } from '@/components/common/OutcomeBadge'
import type { CoinId, TimeframeId } from '@/lib/types'
import type { Position } from '@/lib/api'

export function PortfolioPanel({
  enabled,
  timeframe,
  selectedCoin,
}: {
  enabled: boolean
  timeframe: TimeframeId
  /** Highlights / sorts this coin first — positions are not hidden by coin. */
  selectedCoin?: CoinId
}) {
  const config = useUpdateConfig()
  const tfLabel = getTimeframe(timeframe).shortLabel
  const now = useNow()
  const recentFillVersion = useRecentFillVersion()
  const ordersQuery = useOrdersQuery(enabled)
  const positionsQuery = usePositionsQuery(enabled)
  const resolvedPositions = useResolvedPositionsQuery(enabled).data ?? []
  const watchlist = useWatchlistQuery(timeframe, config.pollMs, now)

  const watchlistMarkets = useMemo(
    () =>
      watchlist
        .filter((e) => e.market)
        .map((e) => ({
          upTokenId: e.market!.upTokenId ?? null,
          downTokenId: e.market!.downTokenId ?? null,
          meta: {
            eventSlug: e.market!.eventSlug,
            title: e.market!.title,
            timeframe: e.market!.timeframe,
          },
        })),
    [watchlist],
  )

  const marketMetaByToken = useMemo(() => {
    const map = new Map<string, { eventSlug: string; title: string; timeframe: TimeframeId }>()
    for (const m of watchlistMarkets) {
      if (m.upTokenId) map.set(m.upTokenId, m.meta)
      if (m.downTokenId) map.set(m.downTokenId, m.meta)
    }
    return map
  }, [watchlistMarkets])

  const { instant, authoritativeTokenIds } = useTimeframeHoldingsQuery(watchlistMarkets, enabled)

  const orders = ordersQuery.data ?? []
  // No useMemo — recentFills TTL prunes expire silently (no version bump), and
  // `instant`'s identity churns per render anyway, so a memo would never cache.
  void recentFillVersion
  const merged = mergeInstantHoldings(
    positionsQuery.data ?? [],
    instant,
    authoritativeTokenIds,
    marketMetaByToken,
  )
  const pending = mergePendingFillPositions(merged)
  const visible = filterRecentlySoldPositions(pending)
  const positions = filterPositionsByTimeframe(visible, timeframe)
  // `visible` is every crypto up/down position across all timeframes; the tab only shows
  // the selected one. Surface the rest so they never look "missing" (they're one tab away).
  const otherTimeframeCount = Math.max(0, visible.length - positions.length)

  const sell = useSellFlow()
  const tokenPairById = useMemo(() => {
    const map = new Map<string, { upTokenId: string | null; downTokenId: string | null }>()
    for (const m of watchlistMarkets) {
      const pair = { upTokenId: m.upTokenId, downTokenId: m.downTokenId }
      if (m.upTokenId) map.set(m.upTokenId, pair)
      if (m.downTokenId) map.set(m.downTokenId, pair)
    }
    return map
  }, [watchlistMarkets])

  const handleSell = (position: Position, sellPrice: number) => {
    const pair = tokenPairById.get(position.tokenId)
    return sell.sell(position, sellPrice, undefined, pair)
  }
  const { cancellingId, cancel } = useCancelFlow()

  const positionTokenIds = useMemo(
    () => [...new Set(positions.map((p) => p.tokenId))],
    [positions],
  )
  const orderTokenIds = useMemo(
    () => [...new Set(orders.map((o) => o.assetId))],
    [orders],
  )

  const quoteOpts = { enabled: enabled && config.useWebSocket, throttleMs: config.throttleMs }
  const { quotes: positionQuotes } = useTokenQuotes(positionTokenIds, quoteOpts)
  const { quotes: orderQuotes } = useTokenQuotes(orderTokenIds, quoteOpts)

  if (!enabled) {
    return (
      <p className="rounded-lg bg-secondary/50 px-3 py-6 text-center text-sm text-muted-foreground">
        Connect a trading wallet to see positions and open orders.
      </p>
    )
  }

  const loading =
    (positionsQuery.isLoading || ordersQuery.isLoading) &&
    positionTokenIds.length === 0 &&
    orderTokenIds.length === 0

  return (
    <>
      <Tabs defaultValue="positions" className="min-w-0 gap-3">
        <TabsList className="w-full">
          <TabsTrigger value="positions" className="flex-1">
            {tfLabel} Positions{' '}
            {positions.length > 0 && <span className="ml-1 opacity-70">{positions.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="orders" className="flex-1">
            Open Orders {orders.length > 0 && <span className="ml-1 opacity-70">{orders.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="history" className="flex-1">
            History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="positions">
          {loading ? (
            <PortfolioSkeleton />
          ) : (
            <div className="flex flex-col gap-3">
              {positions.length === 0 ? (
                <EmptyHint>
                  No open {tfLabel} positions.
                  {otherTimeframeCount > 0 &&
                    ` You have ${otherTimeframeCount} in ${
                      otherTimeframeCount === 1 ? 'another timeframe' : 'other timeframes'
                    } — switch the timeframe to view ${otherTimeframeCount === 1 ? 'it' : 'them'}.`}
                </EmptyHint>
              ) : (
                <>
                  <PortfolioSummary positions={positions} quotes={positionQuotes} />
                  <PositionGroupsByCoin
                    positions={positions}
                    quotes={positionQuotes}
                    sell={sell}
                    onSell={handleSell}
                    selectedCoin={selectedCoin}
                  />
                  {otherTimeframeCount > 0 && (
                    <p className="px-1 pt-0.5 text-center text-[0.7rem] text-muted-foreground">
                      + {otherTimeframeCount} more in other timeframes
                    </p>
                  )}
                </>
              )}
              <ResolvedPositionsSection positions={resolvedPositions} />
            </div>
          )}
        </TabsContent>

        <TabsContent value="orders">
          {loading ? (
            <PortfolioSkeleton />
          ) : orders.length === 0 ? (
            <EmptyHint>No open orders.</EmptyHint>
          ) : (
            <ul className="flex flex-col gap-2">
              {orders.map((o) => (
                <OrderRow
                  key={o.id}
                  order={o}
                  positions={positions}
                  quote={orderQuotes[o.assetId]}
                  cancelling={cancellingId === o.id}
                  onCancel={cancel}
                />
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="history" className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-[0.65rem] text-muted-foreground">
              Filled orders, newest first.
            </span>
            <ExportHistoryButton />
          </div>
          <TradeHistory enabled={enabled} />
        </TabsContent>
      </Tabs>
    </>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-1 py-6 text-center text-sm leading-snug text-muted-foreground break-words">
      {children}
    </p>
  )
}

/** Top-line roll-up across every shown position: live value + unrealized P&L. */
function PortfolioSummary({
  positions,
  quotes,
}: {
  positions: Position[]
  quotes: Record<string, import('@/lib/clobSocket').TokenQuote>
}) {
  const summary = useMemo(() => {
    const legs = positions.map((p) => buildPositionLeg(p, quotes[p.tokenId]))
    return summarizePair(legs)
  }, [positions, quotes])

  const { totalValue, totalCost, netPnl, netPnlPct } = summary
  const pnlPositive = (netPnl ?? 0) >= 0

  return (
    <div className="rounded-lg border bg-secondary/40 px-3 py-2.5">
      <div className="flex items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground">
            Positions value
          </span>
          <span className="text-xl font-extrabold leading-tight tabular-nums">
            {totalValue != null ? `$${totalValue.toFixed(2)}` : '—'}
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <span className="text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground">
            Unrealized P&L
          </span>
          {netPnl != null ? (
            <span
              className={cn(
                'text-base font-extrabold leading-tight tabular-nums',
                pnlPositive ? 'text-up' : 'text-down',
              )}
            >
              {formatPnlUsd(netPnl)}
              {netPnlPct != null && (
                <span className="ml-1.5 text-xs opacity-90">{formatPnlPct(netPnlPct)}</span>
              )}
            </span>
          ) : (
            <span className="text-base font-bold text-muted-foreground">—</span>
          )}
        </div>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[0.65rem] tabular-nums text-muted-foreground">
        <span>
          {positions.length} position{positions.length === 1 ? '' : 's'}
        </span>
        {totalCost != null && <span>· ${totalCost.toFixed(2)} cost</span>}
      </div>
    </div>
  )
}

/** Collapsible backlog of resolved (redeemable) positions across all timeframes. */
function ResolvedPositionsSection({ positions }: { positions: Position[] }) {
  const [open, setOpen] = useState(false)

  const sorted = useMemo(
    () => [...positions].sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0)),
    [positions],
  )
  const totalValue = useMemo(
    () => positions.reduce((sum, p) => sum + (p.currentValue ?? 0), 0),
    [positions],
  )

  if (positions.length === 0) return null

  const CAP = 50
  const shown = sorted.slice(0, CAP)
  const hidden = sorted.length - shown.length

  return (
    <div className="rounded-lg border bg-secondary/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <ChevronRightIcon className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          Resolved
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.6rem] font-bold tabular-nums">
            {positions.length}
          </span>
        </span>
        <span className="shrink-0 text-xs font-bold tabular-nums text-muted-foreground">
          ~${totalValue.toFixed(2)} to redeem
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-2 pb-2">
          <p className="px-1 text-[0.65rem] leading-snug text-muted-foreground">
            Resolved across all timeframes. Redeem on Polymarket to claim winnings.
          </p>
          <ul className="flex flex-col gap-2">
            {shown.map((p) => (
              <PositionRow key={p.tokenId} position={p} onSell={() => {}} />
            ))}
          </ul>
          {hidden > 0 && (
            <p className="px-1 text-center text-[0.65rem] text-muted-foreground">
              + {hidden} more resolved
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function PositionGroupsByCoin({
  positions,
  quotes,
  sell,
  onSell,
  selectedCoin,
}: {
  positions: Position[]
  quotes: Record<string, import('@/lib/clobSocket').TokenQuote>
  sell: ReturnType<typeof useSellFlow>
  onSell: (position: Position, sellPrice: number) => void
  selectedCoin?: CoinId
}) {
  const selectedSymbol = selectedCoin?.toUpperCase()

  const groups = useMemo(() => {
    const byCoin = groupPositionsByCoin(positions)
    return [...byCoin.entries()].sort(([aSym], [bSym]) => {
      if (selectedSymbol) {
        if (aSym === selectedSymbol) return -1
        if (bSym === selectedSymbol) return 1
      }
      return aSym.localeCompare(bSym)
    })
  }, [positions, selectedSymbol])

  return (
    <ul className="flex flex-col gap-4">
      {groups.map(([symbol, rows]) => {
        // Deterministic order (Up before Down, then token id) so rows don't reshuffle
        // as the instant/global holdings polls and optimistic overlays interleave.
        const orderedRows = [...rows].sort((a, b) => {
          const sa = outcomeSide(a.outcome) === 'up' ? 0 : 1
          const sb = outcomeSide(b.outcome) === 'up' ? 0 : 1
          return sa - sb || a.tokenId.localeCompare(b.tokenId)
        })
        const legs = orderedRows.map((p) => buildPositionLeg(p, quotes[p.tokenId]))
        const recommendation = recommendSellFirst(legs)
        const summary = summarizePair(legs)
        const netPositive = (summary.netPnl ?? 0) >= 0
        const windowLabel = formatPositionLabel(orderedRows[0]).window
        const isFocused = selectedSymbol === symbol

        return (
          <li key={symbol} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2 px-1">
              <span
                className={cn(
                  'truncate text-[0.65rem] font-semibold uppercase tracking-wide',
                  isFocused ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                {symbol}
                {windowLabel && (
                  <span className="ml-1.5 normal-case font-medium opacity-80">{windowLabel}</span>
                )}
                {orderedRows.length === 2 && (
                  <span className="ml-1 normal-case opacity-60">· Up + Down</span>
                )}
              </span>
              {summary.netPnl != null && (
                <span
                  className={cn(
                    'shrink-0 text-[0.65rem] font-bold tabular-nums',
                    netPositive ? 'text-up' : 'text-down',
                  )}
                >
                  {formatPnlUsd(summary.netPnl)}
                  {summary.netPnlPct != null && (
                    <span className="ml-1 opacity-90">{formatPnlPct(summary.netPnlPct)}</span>
                  )}
                </span>
              )}
            </div>
            {recommendation.first && orderedRows.length > 1 && (
              <p className="px-1 text-[0.6rem] text-muted-foreground">{recommendation.reason}</p>
            )}
            <ul className="flex flex-col gap-2">
              {orderedRows.map((p) => (
                <PositionRow
                  key={p.tokenId}
                  position={p}
                  quote={quotes[p.tokenId]}
                  selling={sell.sellingId === p.tokenId}
                  sellFirst={recommendation.first === outcomeSide(p.outcome)}
                  onSell={onSell}
                />
              ))}
            </ul>
          </li>
        )
      })}
    </ul>
  )
}

function PortfolioSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-14 w-full rounded-lg" />
      <Skeleton className="h-14 w-full rounded-lg" />
    </div>
  )
}
