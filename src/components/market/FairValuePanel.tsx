import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { formatPercent } from '@/lib/polymarket'
import { downloadFile } from '@/lib/exportHistory'
import { exportPredictionLog, getCalibration } from '@/lib/predictionLog'
import { cn } from '@/lib/utils'
import { qk } from '@/queries/keys'
import { Button } from '@/components/ui/button'
import type { FairValue } from '@/hooks/useFairValue'
import type { MarketSpot } from '@/hooks/useMarketSpot'
import type { FairValueConfidence } from '@/lib/fairValue'

const CONFIDENCE_BADGE: Record<
  Exclude<FairValueConfidence, 'no-data'>,
  { label: string; className: string }
> = {
  ok: { label: 'Live', className: 'bg-up-soft text-up' },
  'low-sample': { label: 'Warming up', className: 'bg-secondary text-muted-foreground' },
  stale: { label: 'Feed stale', className: 'bg-amber-500/10 text-amber-300' },
  'wide-spread': { label: 'Wide spread', className: 'bg-amber-500/10 text-amber-300' },
}

function formatVolPct(value: number): string {
  return `${value.toFixed(value < 0.1 ? 3 : 2)}%`
}

/**
 * Model vs. market for the live window: digital-option P(Up) from realized
 * Chainlink vol next to the book's own odds, with the gap called out when it's
 * wide enough to matter. Hidden for coins without a Chainlink stream and
 * outside the measurement window.
 */
export function FairValuePanel({ fv, spot }: { fv: FairValue; spot: MarketSpot }) {
  const calibration = useQuery({
    queryKey: qk.predictionCalibration,
    queryFn: getCalibration,
    refetchInterval: 60_000,
    staleTime: 55_000,
  })

  if (fv.confidence === 'no-data' || spot.completed || spot.strikePhase !== 'locked') {
    return null
  }

  const badge = CONFIDENCE_BADGE[fv.confidence]
  const edgePts = fv.edge != null ? fv.edge * 100 : null
  const stats = calibration.data

  const onExport = () => {
    void exportPredictionLog()
      .then((json) => {
        const stamp = new Date().toISOString().slice(0, 10)
        downloadFile(`prediction-log-${stamp}.json`, json, 'application/json')
      })
      .catch(() => {})
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/60 p-4">
      <div className="flex items-center justify-between">
        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
          Fair value model
        </p>
        <span className={cn('rounded-md px-1.5 py-0.5 text-[0.65rem] font-semibold', badge.className)}>
          {badge.label}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <ModelStat label="Model Up" value={fv.modelP != null ? formatPercent(fv.modelP) : '—'} />
        <ModelStat label="Market Up" value={fv.marketP != null ? formatPercent(fv.marketP) : '—'} />
        <ModelStat
          label="Edge"
          value={edgePts != null ? `${edgePts >= 0 ? '+' : ''}${edgePts.toFixed(1)} pts` : '—'}
          className={
            edgePts == null ? undefined : edgePts >= 0 ? 'text-up' : 'text-down'
          }
        />
      </div>

      {fv.signal && (
        <p className="rounded-lg bg-primary/10 px-3 py-2 text-center text-xs font-medium text-primary">
          Model sees <span className="font-semibold">{fv.signal === 'up' ? 'Up' : 'Down'}</span> underpriced —{' '}
          {formatPercent(fv.signal === 'up' ? fv.modelP! : 1 - fv.modelP!)} fair vs{' '}
          {formatPercent(fv.signal === 'up' ? fv.marketP! : 1 - fv.marketP!)} market
        </p>
      )}

      <div className="flex items-center justify-between gap-2 text-[0.65rem] text-muted-foreground">
        <span>
          {fv.volPerMinPct != null ? (
            <>
              σ {formatVolPct(fv.volPerMinPct)}/min · window σ {fv.sigmaWindowPct != null ? formatVolPct(fv.sigmaWindowPct) : '—'}
            </>
          ) : (
            'Measuring realized volatility…'
          )}
        </span>
        <span className="flex items-center gap-1.5">
          {stats && stats.samples > 0 && stats.brierModel != null && stats.brierMarket != null && (
            <span title={`${stats.scoredWindows} scored windows · ${stats.samples} samples · lower is better`}>
              Brier {stats.brierModel.toFixed(3)} vs mkt {stats.brierMarket.toFixed(3)}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-5 text-muted-foreground"
            onClick={onExport}
            title="Export prediction log (JSON)"
          >
            <Download className="size-3" />
          </Button>
        </span>
      </div>
    </div>
  )
}

function ModelStat({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className="flex flex-col items-center rounded-lg bg-secondary px-2 py-2">
      <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn('text-sm font-bold tabular-nums', className)}>{value}</span>
    </div>
  )
}
