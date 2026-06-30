import { getCoin } from '@/lib/config'
import { cn } from '@/lib/utils'
import type { CoinId } from '@/lib/types'

const SIZES = {
  sm: 'size-7 text-[0.65rem] rounded-md',
  md: 'size-9 text-xs rounded-lg',
  lg: 'size-11 text-sm rounded-xl',
} as const

export function CoinBadge({
  coin,
  size = 'md',
  className,
}: {
  coin: CoinId
  size?: keyof typeof SIZES
  className?: string
}) {
  const meta = getCoin(coin)
  return (
    <span
      className={cn('grid shrink-0 place-items-center font-extrabold text-white', SIZES[size], className)}
      style={{ background: meta.color }}
      title={meta.name}
    >
      {meta.symbol}
    </span>
  )
}
