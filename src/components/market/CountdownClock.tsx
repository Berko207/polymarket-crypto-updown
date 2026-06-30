import { useEffect, useState } from 'react'
import { formatCountdown, getCountdownTarget } from '@/lib/polymarket'
import { cn } from '@/lib/utils'
import type { ParsedMarket } from '@/lib/types'

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
  const initial = getCountdownTarget(market)
  const [label, setLabel] = useState(initial.label)
  const [value, setValue] = useState(() => formatCountdown(initial.target))

  // Window identity — restart the ticker when the market/window changes, not on every poll.
  const key = `${market.eventSlug}:${market.endDate.getTime()}:${market.startDate?.getTime() ?? ''}`

  useEffect(() => {
    const tick = () => {
      const info = getCountdownTarget(market)
      setLabel(info.label)
      setValue(formatCountdown(info.target))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return (
    <div className={cn('flex flex-col', align === 'right' ? 'items-end text-right' : 'items-start', className)} aria-live="polite">
      <span className="text-[0.6rem] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="font-mono text-xl font-extrabold tabular-nums text-primary">{value}</span>
    </div>
  )
}
