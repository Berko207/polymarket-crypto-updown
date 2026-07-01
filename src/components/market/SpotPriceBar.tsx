import { ArrowDown, ArrowUp } from 'lucide-react'
import { coinSymbol, formatSpotDelta, formatSpotUsd } from '@/lib/cryptoPrice'
import { marketWindowLabel } from '@/lib/marketLabels'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import type { MarketSpot } from '@/hooks/useMarketSpot'
import type { ParsedMarket } from '@/lib/types'

export function SpotPriceBar({ market, spot }: { market: ParsedMarket; spot: MarketSpot }) {
  if (!market.startDate) return null

  const { strike, strikePhase, current, currentPhase, delta, completed } = spot
  const up = delta != null && delta >= 0
  const windowLabel = marketWindowLabel(market.title)

  return (
    <div className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-secondary/60 p-4">
      <p className="col-span-2 text-center text-xs font-medium text-muted-foreground">{windowLabel}</p>

      <div>
        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
          Price to beat
        </p>
        <StrikeValue market={market} strike={strike} phase={strikePhase} />
      </div>

      <div className="text-right">
        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
          {completed ? 'Final price' : 'Current price'}
        </p>
        <div className="mt-1 flex flex-col items-end gap-1">
          <CurrentValue market={market} current={current} phase={currentPhase} completed={completed} />
          {delta != null && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-bold tabular-nums',
                up ? 'bg-up-soft text-up' : 'bg-down-soft text-down',
              )}
            >
              {up ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
              {formatSpotDelta(market.coin, delta)}
            </span>
          )}
        </div>
      </div>

      <p className="col-span-2 text-center text-[0.65rem] text-muted-foreground">
        {currentPhase === 'live' && !completed && (
          <span className="mr-1.5 inline-flex items-center gap-1 text-up">
            <span className="size-1.5 animate-pulse rounded-full bg-up" />
            Live
          </span>
        )}
        Polymarket resolution · Chainlink {coinSymbol(market.coin)}/USD
        {delta != null && (
          <>
            {' · '}
            {up ? 'Up' : 'Down'} leading
            {completed ? ' · window closed' : ''}
          </>
        )}
      </p>
    </div>
  )
}

function StrikeValue({
  market,
  strike,
  phase,
}: {
  market: ParsedMarket
  strike: number | null
  phase: MarketSpot['strikePhase']
}) {
  if (strike != null) {
    return (
      <>
        <p className="mt-1 text-2xl font-extrabold tabular-nums tracking-tight">
          {formatSpotUsd(market.coin, strike)}
        </p>
        <p className="mt-0.5 text-[0.65rem] text-muted-foreground">
          {phase === 'locked'
            ? 'Locked at window open'
            : phase === 'preview'
              ? 'Preview — locks at window open'
              : null}
        </p>
      </>
    )
  }

  if (phase === 'loading') {
    return <Skeleton className="mt-1 h-8 w-36" />
  }

  return (
    <p className="mt-1 text-sm text-muted-foreground">
      {phase === 'unavailable' ? 'Strike unavailable' : 'Available when the window opens'}
    </p>
  )
}

function CurrentValue({
  market,
  current,
  phase,
  completed,
}: {
  market: ParsedMarket
  current: number | null
  phase: MarketSpot['currentPhase']
  completed: boolean
}) {
  if (current != null) {
    return (
      <p className="text-2xl font-extrabold tabular-nums tracking-tight">
        {formatSpotUsd(market.coin, current)}
      </p>
    )
  }

  if (phase === 'loading' && !completed) {
    return <Skeleton className="h-8 w-36" />
  }

  return <p className="text-sm text-muted-foreground">—</p>
}
