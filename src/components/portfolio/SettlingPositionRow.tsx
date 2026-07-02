import { useSettlingMark } from '@/hooks/useSettlingMark'
import { PositionRow } from './PositionRow'
import type { Position } from '@/lib/api'

/**
 * Settling row with the resolved outcome marked in: once the window's final
 * price is known (Chainlink boundary tick or the crypto-price API), the row
 * prices at $1/$0 instead of freezing on the last pre-close quote.
 */
export function SettlingPositionRow({ position }: { position: Position }) {
  const mark = useSettlingMark(position)
  return <PositionRow position={position} settling markOverride={mark} onSell={() => {}} />
}
