import { useEffect } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { useLiveMarket } from '@/queries/market'
import { useWarmTradingPath } from '@/queries/trading'
import { formatMarketHeading } from '@/lib/marketLabels'
import { rememberMarketTokens } from '@/lib/tokenLabels'
import { formatPercent, formatVolume } from '@/lib/polymarket'
import { cn } from '@/lib/utils'
import { usePriceFlash, flashColor } from '@/hooks/usePriceFlash'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { CoinBadge } from '@/components/common/CoinBadge'
import { LiveStatusBadge } from '@/components/common/LiveStatusBadge'
import { CountdownClock } from './CountdownClock'
import { OddsGauge } from './OddsGauge'
import { SpotPriceBar } from './SpotPriceBar'
import { TradePanel } from './TradePanel'
import { ProbabilityBar } from '@/components/common/ProbabilityBar'
import { spotOddsDiverge, useMarketSpot } from '@/hooks/useMarketSpot'
import { timeframeFromEventSlug } from '@/lib/slugs'
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
  const { market, isLoading, isError, error, rolling, connected } = useLiveMarket(coin, timeframe)
  const spot = useMarketSpot(market, coin, timeframe)
  const subtitle = market ? formatMarketHeading(market).subtitle : ''

  useEffect(() => {
    if (market) rememberMarketTokens(market.upTokenId, market.downTokenId, subtitle)
  }, [market?.upTokenId, market?.downTokenId, subtitle])

  useWarmTradingPath(
    market ? [market.upTokenId, market.downTokenId].filter((id): id is string => Boolean(id)) : [],
    canTrade && Boolean(market?.isLive),
  )

  if (isLoading && !market) return <DetailSkeleton />
  if (market && timeframeFromEventSlug(market.eventSlug) !== timeframe) {
    return <DetailSkeleton />
  }
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
  const oddsLagSpot = spotOddsDiverge(spot, market.upPrice)
  const spotFavorsUp = spot.delta != null && spot.delta >= 0

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 p-5">
        {rolling && (
          <div className="flex items-center justify-center gap-2 rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary">
            <Loader2 className="size-3.5 animate-spin" />
            Round ended — loading next market…
          </div>
        )}

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
            <LiveStatusBadge active={market.isLive} connected={connected} idleLabel="Closed" />
          </div>
        </header>

        <SpotPriceBar key={market.eventSlug} market={market} spot={spot} />

        {oddsLagSpot && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-center text-xs text-amber-200">
            Order-book odds may lag — resolution price currently favors{' '}
            <span className="font-semibold">{spotFavorsUp ? 'Up' : 'Down'}</span>.
          </p>
        )}

        {/* Keyed per window: rollover swaps markets in place (useLiveMarket bridges the
            gap), and the odds jump (e.g. 0.97 → 0.50) must not read as a price flash.
            Prefixed — SpotPriceBar above already uses the bare eventSlug as its key,
            and duplicate sibling keys corrupt React reconciliation. */}
        <div
          key={`odds-${market.eventSlug}`}
          className="flex flex-col items-center gap-5 sm:flex-row sm:justify-center sm:gap-10"
        >
          <OddsGauge value={market.upPrice} size={150} label="Market Up" />
          <div className="grid w-full max-w-xs grid-cols-2 gap-2 sm:w-52">
            <OutcomeStat label="Up" price={market.upPrice} side="up" />
            <OutcomeStat label="Down" price={market.downPrice} side="down" />
          </div>
        </div>

        <ProbabilityBar upPrice={market.upPrice} />

        {canTrade ? (
          <TradePanel
            market={market}
            coinSymbol={coinMeta.symbol}
            subtitle={heading.subtitle}
            quotesLive={connected}
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

function OutcomeStat({ label, price, side }: { label: string; price: number; side: 'up' | 'down' }) {
  const flash = usePriceFlash(price)
  return (
    <div className={cn('flex flex-col items-center rounded-lg px-3 py-2.5', side === 'up' ? 'bg-up-soft' : 'bg-down-soft')}>
      <span className={cn('text-xs font-semibold uppercase', side === 'up' ? 'text-up' : 'text-down')}>{label}</span>
      <span
        className={cn(
          'text-xl font-extrabold tabular-nums transition-colors duration-500',
          flashColor(flash),
        )}
      >
        {formatPercent(price)}
      </span>
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
