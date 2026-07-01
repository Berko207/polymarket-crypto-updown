import { useCallback, useEffect, useRef } from 'react'
import { useTradeHistoryQuery } from '@/queries/portfolio'
import { useNow } from '@/hooks/useNow'
import { formatPercent } from '@/lib/polymarket'
import { coinSymbolFromTitle, marketWindowLabel } from '@/lib/marketLabels'
import { timeframeFromEventSlug } from '@/lib/slugs'
import { getTimeframe } from '@/lib/config'
import { cn } from '@/lib/utils'
import { OutcomeBadge } from '@/components/common/OutcomeBadge'
import { TimeframeBadge } from '@/components/common/TimeframeBadge'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import type { TradeFill } from '@/lib/api'

function timeAgo(tsSeconds: number, nowMs: number): string {
  if (!tsSeconds) return ''
  const diff = Math.max(0, Math.floor(nowMs / 1000) - tsSeconds)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`
  return new Date(tsSeconds * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

function TradeRow({ trade, nowMs }: { trade: TradeFill; nowMs: number }) {
  const isBuy = trade.side === 'BUY'
  const tf = timeframeFromEventSlug(trade.eventSlug)
  const tfLabel = tf ? getTimeframe(tf).shortLabel : null
  const symbol = coinSymbolFromTitle(trade.title)
  const window = marketWindowLabel(trade.title)
  const value = trade.size * trade.price

  return (
    <li className="flex items-start justify-between gap-3 rounded-lg bg-secondary px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <OutcomeBadge outcome={trade.outcome} />
          {tfLabel && <TimeframeBadge label={tfLabel} />}
          <span className="truncate text-sm font-medium">
            {[symbol, window].filter(Boolean).join(' · ')}
          </span>
        </div>
        <div className="mt-1 text-xs tabular-nums text-muted-foreground">
          <span className={cn('font-semibold', isBuy ? 'text-up' : 'text-down')}>
            {isBuy ? 'Bought' : 'Sold'}
          </span>{' '}
          {trade.size.toFixed(2)} @ {formatPercent(trade.price)}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span className="text-sm font-bold tabular-nums">${value.toFixed(2)}</span>
        <span className="text-[0.65rem] text-muted-foreground">
          {timeAgo(trade.timestamp, nowMs)}
        </span>
      </div>
    </li>
  )
}

/**
 * Filled-order history: newest first, scrollable, and auto-loading — an
 * IntersectionObserver on the bottom sentinel pulls the next Data-API page
 * whenever it scrolls into view (no "load more" button).
 */
export function TradeHistory({ enabled }: { enabled: boolean }) {
  const query = useTradeHistoryQuery(enabled)
  const now = useNow()
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])

  const trades = query.data?.pages.flatMap((p) => p.trades) ?? []

  // Re-observe after each page so a sentinel still in view keeps loading
  // until the list overflows the container (transitions alone wouldn't refire).
  const pageCount = query.data?.pages.length ?? 0
  useEffect(() => {
    const root = scrollRef.current
    const target = sentinelRef.current
    if (!root || !target) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore()
      },
      { root, rootMargin: '120px' },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [loadMore, pageCount])

  if (!enabled) return null

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-14 w-full rounded-lg" />
        <Skeleton className="h-14 w-full rounded-lg" />
      </div>
    )
  }

  if (query.isError) {
    return (
      <div className="flex flex-col items-center gap-2 px-1 py-6 text-center">
        <p className="text-sm text-muted-foreground">
          {query.error instanceof Error ? query.error.message : 'Could not load history.'}
        </p>
        <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    )
  }

  if (trades.length === 0) {
    return <p className="px-1 py-6 text-center text-sm text-muted-foreground">No fills yet.</p>
  }

  return (
    <div ref={scrollRef} className="max-h-96 overflow-y-auto overscroll-contain pr-0.5">
      <ul className="flex flex-col gap-2">
        {trades.map((t) => (
          <TradeRow key={t.id} trade={t} nowMs={now} />
        ))}
      </ul>
      <div ref={sentinelRef} className="flex justify-center py-2">
        {isFetchingNextPage ? (
          <span className="text-[0.65rem] text-muted-foreground">Loading more…</span>
        ) : !hasNextPage ? (
          <span className="text-[0.65rem] text-muted-foreground/70">End of history</span>
        ) : null}
      </div>
    </div>
  )
}
