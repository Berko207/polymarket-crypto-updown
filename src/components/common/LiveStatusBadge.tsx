import { cn } from '@/lib/utils'

/**
 * Connection/liveness indicator shared by the focused market header (pill) and the
 * watchlist header (bare text). `active` gates the Live/Connecting… states — market
 * window open, or WS streaming enabled — otherwise the idle label/tone shows.
 */
export function LiveStatusBadge({
  active,
  connected,
  idleLabel,
  variant = 'pill',
  className,
}: {
  active: boolean
  connected: boolean
  idleLabel: string
  variant?: 'pill' | 'text'
  className?: string
}) {
  const pill = variant === 'pill'
  const label = !active ? idleLabel : connected ? 'Live' : 'Connecting…'
  const tone = !active
    ? pill
      ? 'bg-primary/15 text-primary'
      : 'text-muted-foreground'
    : connected
      ? pill
        ? 'bg-up-soft text-up'
        : 'text-up'
      : pill
        ? 'bg-amber-500/15 text-amber-400'
        : 'text-amber-400'

  return (
    <span
      className={cn(
        'inline-flex items-center uppercase tracking-wide',
        pill
          ? 'gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-bold'
          : 'gap-1 text-[0.6rem] font-semibold',
        tone,
        className,
      )}
    >
      <span
        className={cn('size-1.5 rounded-full bg-current', active && connected && 'animate-pulse')}
      />
      {label}
    </span>
  )
}
