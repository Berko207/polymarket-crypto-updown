import { useEffect } from 'react'
import { ExternalLink } from 'lucide-react'
import { useLiveMarket } from '@/queries/market'
import { useWarmTradingPath } from '@/queries/trading'
import { formatMarketHeading } from '@/lib/marketLabels'
import { rememberMarketTokens } from '@/lib/tokenLabels'
import { formatPercent, formatVolume } from '@/lib/polymarket'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { CoinBadge } from '@/components/common/CoinBadge'
import { CountdownClock } from './CountdownClock'
import { OddsGauge } from './OddsGauge'
import { TradePanel } from './TradePanel'
import { getCoin } from '@/lib/config'
import type { CoinId, ParsedMarket, TimeframeId } from '@/lib/types'

export function MarketDetail({
  coin,
  timeframe,
  canTrade,
}: {
  coin: CoinId
  timeframe: TimeframeId
  canTrade: boolean
}) {
  const { market, isLoading, isError, error } = useLiveMarket(coin, timeframe)
  const subtitle = market ? formatMarketHeading(market).subtitle : ''

  useEffect(() => {
    if (market) rememberMarketTokens(market.upTokenId, market.downTokenId, subtitle)
  }, [market?.upTokenId, market?.downTokenId, subtitle])

  useWarmTradingPath(
    market ? [market.upTokenId, market.downTokenId].filter((id): id is string => Boolean(id)) : [],
    canTrade && Boolean(market?.isLive),
  )

  if (isLoading && !market) return <DetailSkeleton />
  if (isError && !market) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground">
          <p>{error instanceof Error ? error.message : 'Failed to load market'}</p>
        </CardContent>
      </Card>
    )
  }
  if (!market) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          No active market for this coin &amp; timeframe.
        </CardContent>
      </Card>
    )
  }

  const heading = formatMarketHeading(market)
  const coinMeta = getCoin(market.coin)
  const upPct = Math.round(market.upPrice * 100)

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 p-5">
        <header className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <CoinBadge coin={market.coin} size="lg" />
            <div>
              <h2 className="text-base font-bold leading-tight">{heading.title}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{heading.subtitle}</p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <CountdownClock market={market} />
            <LiveBadge isLive={market.isLive} />
          </div>
        </header>

        <div className="flex flex-col items-center gap-5 sm:flex-row sm:justify-center sm:gap-10">
          <OddsGauge value={market.upPrice} size={150} />
          <div className="grid w-full max-w-xs grid-cols-2 gap-2 sm:w-52">
            <OutcomeStat label="Up" price={market.upPrice} side="up" />
            <OutcomeStat label="Down" price={market.downPrice} side="down" />
          </div>
        </div>

        <ProbabilityBar upPct={upPct} />

        {canTrade ? (
          <TradePanel
            market={market}
            coinSymbol={coinMeta.symbol}
            subtitle={heading.subtitle}
          />
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            <OutcomeLink market={market} side="up" />
            <OutcomeLink market={market} side="down" />
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Stat label="Volume" value={formatVolume(market.volume)} />
          <Stat label="Liquidity" value={formatVolume(market.liquidity)} />
        </div>

        {market.priceChange1h != null && (
          <p className={cn('text-center text-sm', market.priceChange1h >= 0 ? 'text-up' : 'text-down')}>
            1h change: {market.priceChange1h >= 0 ? '+' : ''}
            {Math.round(market.priceChange1h * 100)}¢
          </p>
        )}

        <Button asChild variant="secondary" className="w-full">
          <a href={market.polymarketUrl} target="_blank" rel="noopener noreferrer">
            {canTrade ? 'View on Polymarket' : 'Trade on Polymarket'}
            <ExternalLink className="size-4" />
          </a>
        </Button>
      </CardContent>
    </Card>
  )
}

function LiveBadge({ isLive }: { isLive: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-bold uppercase tracking-wide',
        isLive ? 'bg-up-soft text-up' : 'bg-primary/15 text-primary',
      )}
    >
      <span className={cn('size-1.5 rounded-full bg-current', isLive && 'animate-pulse')} />
      {isLive ? 'Live' : 'Closed'}
    </span>
  )
}

function OutcomeStat({ label, price, side }: { label: string; price: number; side: 'up' | 'down' }) {
  return (
    <div className={cn('flex flex-col items-center rounded-lg px-3 py-2.5', side === 'up' ? 'bg-up-soft' : 'bg-down-soft')}>
      <span className={cn('text-xs font-semibold uppercase', side === 'up' ? 'text-up' : 'text-down')}>{label}</span>
      <span className="text-xl font-extrabold tabular-nums">{formatPercent(price)}</span>
    </div>
  )
}

function OutcomeLink({ market, side }: { market: ParsedMarket; side: 'up' | 'down' }) {
  return (
    <a
      href={market.polymarketUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'flex flex-col items-center gap-1 rounded-xl border px-3 py-4 transition active:scale-[0.98]',
        side === 'up' ? 'border-up/40 bg-up-soft text-up' : 'border-down/40 bg-down-soft text-down',
      )}
    >
      <span className="text-sm font-semibold opacity-90">{side === 'up' ? 'Up' : 'Down'}</span>
      <span className="text-2xl font-extrabold leading-none">
        {formatPercent(side === 'up' ? market.upPrice : market.downPrice)}
      </span>
    </a>
  )
}

function ProbabilityBar({ upPct }: { upPct: number }) {
  const up = Math.min(100, Math.max(0, upPct))
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-border" aria-hidden="true">
      <div className="bg-up transition-[width] duration-200" style={{ width: `${up}%` }} />
      <div className="bg-down transition-[width] duration-200" style={{ width: `${100 - up}%` }} />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg bg-secondary px-3 py-2.5">
      <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm font-bold">{value}</span>
    </div>
  )
}

function DetailSkeleton() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-5 p-5">
        <div className="flex justify-between">
          <Skeleton className="h-11 w-44 rounded-lg" />
          <Skeleton className="h-11 w-20 rounded-lg" />
        </div>
        <Skeleton className="mx-auto size-[150px] rounded-full" />
        <Skeleton className="h-2 w-full rounded-full" />
        <div className="grid grid-cols-2 gap-2.5">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
      </CardContent>
    </Card>
  )
}
