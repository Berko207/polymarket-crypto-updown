import { getCoin } from '@/lib/config'
import { formatPercent } from '@/lib/polymarket'
import { cn } from '@/lib/utils'
import { usePriceFlash, flashColor } from '@/hooks/usePriceFlash'
import { useSpotLean, formatLeanDelta } from '@/hooks/useSpotLean'
import { CoinBadge } from '@/components/common/CoinBadge'
import { ProbabilityBar } from '@/components/common/ProbabilityBar'
import type { CoinId, ParsedMarket } from '@/lib/types'

/** Live Chainlink spot lean — the moving, per-coin signal while the odds sit at ~50/50. */
function SpotLeanTag({ delta }: { delta: number }) {
  const up = delta >= 0
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-[0.65rem] font-semibold tabular-nums leading-none',
        up ? 'text-up' : 'text-down',
      )}
      title="Live spot vs price to beat"
    >
      {up ? '▲' : '▼'} {formatLeanDelta(delta)}
    </span>
  )
}

export function WatchlistRow({
  coin,
  market,
  upPrice,
  available,
  isLoading,
  selected,
  onSelect,
}: {
  coin: CoinId
  market: ParsedMarket | null
  upPrice: number | null
  available: boolean
  isLoading: boolean
  selected: boolean
  onSelect: (coin: CoinId) => void
}) {
  const meta = getCoin(coin)
  const flash = usePriceFlash(available ? upPrice : null)
  const lean = useSpotLean(coin, available ? market : null)

  return (
    <button
      type="button"
      onClick={() => onSelect(coin)}
      aria-current={selected}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
        selected ? 'bg-secondary ring-1 ring-primary/40' : 'hover:bg-secondary/60',
      )}
    >
      <CoinBadge coin={coin} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">{meta.symbol}</span>
          <div className="flex flex-col items-end gap-0.5 leading-none">
            <span
              className={cn(
                'text-sm font-bold tabular-nums transition-colors duration-500',
                flashColor(flash),
              )}
            >
              {!available ? (
                <span className="text-muted-foreground">—</span>
              ) : upPrice != null ? (
                formatPercent(upPrice)
              ) : isLoading ? (
                <span className="text-muted-foreground">··</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </span>
            {available && lean.delta != null && <SpotLeanTag delta={lean.delta} />}
          </div>
        </div>
        {available && upPrice != null && (
          <div className="mt-1.5">
            <ProbabilityBar upPrice={upPrice} />
          </div>
        )}
      </div>
    </button>
  )
}
