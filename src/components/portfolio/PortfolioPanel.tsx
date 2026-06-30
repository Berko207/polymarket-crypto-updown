import { useMemo } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import {
  mergeInstantHoldings,
  useMarketHoldingsQuery,
  useOrdersQuery,
  usePositionsQuery,
} from '@/queries/portfolio'
import { useMarketQuery } from '@/queries/market'
import { useSellFlow, useCancelFlow } from '@/hooks/usePortfolioActions'
import { useTokenQuotes } from '@/hooks/useTokenQuotes'
import { useUpdateConfig } from '@/store/ui'
import { formatMarketGroupLabel } from '@/lib/marketLabels'
import { formatPnlPct, formatPnlUsd } from '@/lib/positionPnl'
import {
  buildPositionLeg,
  groupPositionsByMarket,
  recommendSellFirst,
  summarizePair,
} from '@/lib/sellPriority'
import { cn } from '@/lib/utils'
import { OrderRow } from './OrderRow'
import { PositionRow } from './PositionRow'
import { outcomeSide } from '@/components/common/OutcomeBadge'
import { OrderConfirmDialog } from '@/components/dialogs/OrderConfirmDialog'
import type { CoinId, TimeframeId } from '@/lib/types'
import type { Position } from '@/lib/api'

export function PortfolioPanel({
  enabled,
  coin,
  timeframe,
}: {
  enabled: boolean
  coin: CoinId
  timeframe: TimeframeId
}) {
  const config = useUpdateConfig()
  const ordersQuery = useOrdersQuery(enabled)
  const positionsQuery = usePositionsQuery(enabled)

  // Focused market's instant on-chain holdings — shares the market cache key (no extra
  // fetch) so a buy in the focused market appears here the moment it fills.
  const focused = useMarketQuery(coin, timeframe, config.pollMs).data
  const holdingsQuery = useMarketHoldingsQuery(
    focused?.upTokenId ?? null,
    focused?.downTokenId ?? null,
    enabled,
  )

  const orders = ordersQuery.data ?? []
  // Only treat the chain as authoritative for the focused tokens once the instant query
  // has actually returned — otherwise a real position would blink out while it loads.
  const focusedTokenIds = useMemo(
    () =>
      holdingsQuery.data
        ? ([focused?.upTokenId, focused?.downTokenId].filter(Boolean) as string[])
        : [],
    [holdingsQuery.data, focused?.upTokenId, focused?.downTokenId],
  )
  const positions = useMemo(
    () =>
      mergeInstantHoldings(
        positionsQuery.data ?? [],
        holdingsQuery.data ?? [],
        focusedTokenIds,
        focused
          ? { eventSlug: focused.eventSlug, title: focused.title, timeframe: focused.timeframe }
          : null,
      ),
    [positionsQuery.data, holdingsQuery.data, focusedTokenIds, focused],
  )

  const sell = useSellFlow()
  const { cancellingId, cancel } = useCancelFlow()

  const tokenIds = useMemo(() => {
    const ids = new Set<string>()
    for (const p of positions) ids.add(p.tokenId)
    for (const o of orders) ids.add(o.assetId)
    return [...ids]
  }, [positions, orders])

  const { quotes } = useTokenQuotes(tokenIds, {
    enabled: enabled && config.useWebSocket,
    throttleMs: config.throttleMs,
  })

  if (!enabled) {
    return (
      <p className="rounded-lg bg-secondary/50 px-3 py-6 text-center text-sm text-muted-foreground">
        Connect a trading wallet to see positions and open orders.
      </p>
    )
  }

  const loading = (positionsQuery.isLoading || ordersQuery.isLoading) && tokenIds.length === 0

  return (
    <>
      <Tabs defaultValue="positions" className="gap-3">
        <TabsList className="w-full">
          <TabsTrigger value="positions" className="flex-1">
            Positions {positions.length > 0 && <span className="ml-1 opacity-70">{positions.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="orders" className="flex-1">
            Open Orders {orders.length > 0 && <span className="ml-1 opacity-70">{orders.length}</span>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="positions">
          {loading ? (
            <PortfolioSkeleton />
          ) : positions.length === 0 ? (
            <EmptyHint>No open positions.</EmptyHint>
          ) : (
            <PositionGroups
              positions={positions}
              quotes={quotes}
              sell={sell}
              focusedKey={focused?.eventSlug ?? null}
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
                  cancelling={cancellingId === o.id}
                  onCancel={cancel}
                />
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>

      <OrderConfirmDialog
        confirm={sell.pending?.confirm ?? null}
        pending={sell.placing}
        onConfirm={sell.submit}
        onOpenChange={(open) => !open && sell.close()}
      />
    </>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-6 text-center text-sm text-muted-foreground">{children}</p>
}

function PositionGroups({
  positions,
  quotes,
  sell,
  focusedKey,
}: {
  positions: Position[]
  quotes: Record<string, import('@/lib/clobSocket').TokenQuote>
  sell: ReturnType<typeof useSellFlow>
  focusedKey: string | null
}) {
  const groups = useMemo(() => {
    const byMarket = groupPositionsByMarket(positions)
    return [...byMarket.entries()].sort(([aKey], [bKey]) => {
      if (aKey === focusedKey) return -1
      if (bKey === focusedKey) return 1
      return 0
    })
  }, [positions, focusedKey])

  return (
    <ul className="flex flex-col gap-3">
      {groups.map(([key, rows]) => {
        const legs = rows.map((p) => buildPositionLeg(p, quotes[p.tokenId]))
        const recommendation = recommendSellFirst(legs)
        const summary = summarizePair(legs)
        const groupLabel = formatMarketGroupLabel(rows)
        const showPairHeader = rows.length > 1
        const netPositive = (summary.netPnl ?? 0) >= 0

        return (
          <li key={key} className="flex flex-col gap-1.5">
            {showPairHeader && (
              <div className="flex items-center justify-between gap-2 px-1">
                <span className="truncate text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  {groupLabel}
                  {rows.length === 2 && <span className="ml-1 normal-case opacity-70">· Up + Down</span>}
                </span>
                <div className="flex shrink-0 items-center gap-2 text-[0.65rem] tabular-nums">
                  {summary.netPnl != null && (
                    <span className={cn('font-bold', netPositive ? 'text-up' : 'text-down')}>
                      {formatPnlUsd(summary.netPnl)}
                      {summary.netPnlPct != null && (
                        <span className="ml-1 opacity-90">{formatPnlPct(summary.netPnlPct)}</span>
                      )}
                    </span>
                  )}
                  {recommendation.first && (
                    <span className="text-muted-foreground">{recommendation.reason}</span>
                  )}
                </div>
              </div>
            )}
            <ul className="flex flex-col gap-2">
              {rows.map((p) => (
                <PositionRow
                  key={p.tokenId}
                  position={p}
                  quote={quotes[p.tokenId]}
                  selling={sell.sellingId === p.tokenId}
                  sellFirst={recommendation.first === outcomeSide(p.outcome)}
                  onSell={sell.request}
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
