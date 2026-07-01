import { useLayoutEffect, useState } from 'react'
import { marketWindowKey } from '@/lib/marketScope'
import { formatCountdown, getCountdownTarget } from '@/lib/polymarket'
import { cn } from '@/lib/utils'
import type { ParsedMarket } from '@/lib/types'

function readCountdown(market: ParsedMarket) {
  const info = getCountdownTarget(market)
  const diff = Math.max(0, Math.floor((info.target.getTime() - Date.now()) / 1000))
  const inShortWindow = market.inWindow && diff < 3600
  if (inShortWindow) {
    return {
      label: info.label,
      mins: Math.floor(diff / 60),
      secs: diff % 60,
      value: '',
    }
  }
  return {
    label: info.label,
    mins: null as number | null,
    secs: null as number | null,
    value: formatCountdown(info.target),
  }
}

/** Ticking countdown to the market's next window boundary. */
export function CountdownClock({
  market,
  className,
  align = 'right',
}: {
  market: ParsedMarket
  className?: string
  align?: 'right' | 'left'
}) {
  const windowKey = marketWindowKey(market)
  const [display, setDisplay] = useState(() => readCountdown(market))

  // Sync before paint when the window changes so a tab switch never flashes the old countdown.
  useLayoutEffect(() => {
    setDisplay(readCountdown(market))
    const tick = () => setDisplay(readCountdown(market))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [windowKey, market])

  return (
    <div
      className={cn('flex flex-col', align === 'right' ? 'items-end text-right' : 'items-start', className)}
      aria-live="polite"
    >
      <span className="text-[0.6rem] font-medium uppercase tracking-wide text-muted-foreground">
        {display.label}
      </span>
      {display.mins != null && display.secs != null ? (
        <div className="flex items-baseline gap-1.5 font-mono tabular-nums">
          <span className="text-xl font-extrabold text-primary">
            {display.mins.toString().padStart(2, '0')}
            <span className="ml-0.5 text-[0.55rem] font-semibold uppercase text-muted-foreground">min</span>
          </span>
          <span className="text-xl font-extrabold text-primary">
            {display.secs.toString().padStart(2, '0')}
            <span className="ml-0.5 text-[0.55rem] font-semibold uppercase text-muted-foreground">sec</span>
          </span>
        </div>
      ) : (
        <span className="font-mono text-xl font-extrabold tabular-nums text-primary">{display.value}</span>
      )}
    </div>
  )
}
