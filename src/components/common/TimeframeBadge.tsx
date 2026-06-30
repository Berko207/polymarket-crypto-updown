import { cn } from '@/lib/utils'

export function TimeframeBadge({
  label,
  className,
}: {
  label: string
  className?: string
}) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-md bg-primary/12 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide text-primary',
        className,
      )}
    >
      {label}
    </span>
  )
}
