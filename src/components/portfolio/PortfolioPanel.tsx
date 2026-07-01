import { useEffect, useMemo } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import {
  filterRecentlySoldPositions,
  mergeInstantHoldings,
  mergePendingFillPositions,
  useOrdersQuery,
  usePositionsQuery,
  useTimeframeHoldingsQuery,
} from '@/queries/portfolio'
import { useWatchlistQuery } from '@/queries/market'
import { useRecentFillVersion } from '@/hooks/useRecentFillVersion'
import { reconcileSoldHides } from '@/lib/recentFills'
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
import { OrderRow } from './OrderRow'
import { PositionRow } from './PositionRow'
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

  useEffect(() => {
    reconcileSoldHides(instant, authoritativeTokenIds)
  }, [instant, authoritativeTokenIds])

  const orders = ordersQuery.data ?? []
  const positions = useMemo(() => {
    const merged = mergeInstantHoldings(
      positionsQuery.data ?? [],
      instant,
      authoritativeTokenIds,
      marketMetaByToken,
    )
    const pending = mergePendingFillPositions(merged)
    const visible = filterRecentlySoldPositions(pending)
    return filterPositionsByTimeframe(visible, timeframe)
  }, [
    positionsQuery.data,
    instant,
    authoritativeTokenIds,
    marketMetaByToken,
    timeframe,
    recentFillVersion,
  ])

  const sell = useSellFlow()
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
        </TabsList>

        <TabsContent value="positions">
          {loading ? (
            <PortfolioSkeleton />
          ) : positions.length === 0 ? (
            <EmptyHint>No open {tfLabel} positions.</EmptyHint>
          ) : (
            <PositionGroupsByCoin
              positions={positions}
              quotes={positionQuotes}
              sell={sell}
              selectedCoin={selectedCoin}
            />
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

function PositionGroupsByCoin({
  positions,
  quotes,
  sell,
  selectedCoin,
}: {
  positions: Position[]
  quotes: Record<string, import('@/lib/clobSocket').TokenQuote>
  sell: ReturnType<typeof useSellFlow>
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
        const legs = rows.map((p) => buildPositionLeg(p, quotes[p.tokenId]))
        const recommendation = recommendSellFirst(legs)
        const summary = summarizePair(legs)
        const netPositive = (summary.netPnl ?? 0) >= 0
        const windowLabel = formatPositionLabel(rows[0]).window
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
                {rows.length === 2 && (
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
            {recommendation.first && rows.length > 1 && (
              <p className="px-1 text-[0.6rem] text-muted-foreground">{recommendation.reason}</p>
            )}
            <ul className="flex flex-col gap-2">
              {rows.map((p) => (
                <PositionRow
                  key={p.tokenId}
                  position={p}
                  quote={quotes[p.tokenId]}
                  selling={sell.sellingId === p.tokenId}
                  sellFirst={recommendation.first === outcomeSide(p.outcome)}
                  onSell={sell.sell}
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
