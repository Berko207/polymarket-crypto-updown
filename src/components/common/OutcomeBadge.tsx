import { cn } from '@/lib/utils'

export type OutcomeSide = 'up' | 'down'

export function outcomeSide(outcome: string): OutcomeSide {
  return outcome.toLowerCase() === 'down' ? 'down' : 'up'
}

export function OutcomeBadge({
  outcome,
  className,
}: {
  outcome: string
  className?: string
}) {
  const side = outcomeSide(outcome)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wide',
        side === 'up' ? 'bg-up-soft text-up' : 'bg-down-soft text-down',
        className,
      )}
    >
      {side === 'up' ? 'Up' : 'Down'}
    </span>
  )
}
