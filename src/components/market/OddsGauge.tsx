import { formatPercent } from '@/lib/polymarket'
import { cn } from '@/lib/utils'

const CIRCUMFERENCE = 327 // 2πr with r=52

/** Circular gauge showing the "Up" probability. Steady layout — no scaling/flash. */
export function OddsGauge({
  value,
  label = 'Up chance',
  size = 140,
  className,
}: {
  value: number
  label?: string
  size?: number
  className?: string
}) {
  const pct = Math.min(1, Math.max(0, value))
  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }}>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="text-3xl font-extrabold leading-none tabular-nums">{formatPercent(value)}</span>
      </div>
      <svg viewBox="0 0 120 120" className="size-full -rotate-90" aria-hidden="true">
        <circle cx="60" cy="60" r="52" fill="none" stroke="var(--border)" strokeWidth="8" />
        <circle
          cx="60"
          cy="60"
          r="52"
          fill="none"
          stroke="var(--up)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${pct * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        />
      </svg>
    </div>
  )
}
