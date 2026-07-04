import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { formatPercent } from '@/lib/polymarket'
import { chainlinkPair } from '@/lib/cryptoPrice'
import { downloadFile } from '@/lib/exportHistory'
import { exportPredictionLog, getCalibration } from '@/lib/predictionLog'
import { VOL_LOOKBACK_MS, volSeries, type FairValueConfidence } from '@/lib/fairValue'
import type { VolRegime } from '@/lib/regime'
import { cn } from '@/lib/utils'
import { qk } from '@/queries/keys'
import { Button } from '@/components/ui/button'
import { useChainlinkHistory } from '@/hooks/useChainlinkHistory'
import type { FairValue } from '@/hooks/useFairValue'
import type { MarketSpot } from '@/hooks/useMarketSpot'
import type { ParsedMarket } from '@/lib/types'

const CONFIDENCE_BADGE: Record<
  Exclude<FairValueConfidence, 'no-data'>,
  { label: string; className: string }
> = {
  ok: { label: 'Live', className: 'bg-up-soft text-up' },
  'low-sample': { label: 'Warming up', className: 'bg-secondary text-muted-foreground' },
  stale: { label: 'Feed stale', className: 'bg-amber-500/10 text-amber-300' },
  'wide-spread': { label: 'Wide spread', className: 'bg-amber-500/10 text-amber-300' },
}

const REGIME_BADGE: Record<VolRegime, { label: string; className: string }> = {
  calm: { label: 'Calm', className: 'bg-up-soft text-up' },
  normal: { label: 'Normal', className: 'bg-secondary text-muted-foreground' },
  elevated: { label: 'Elevated', className: 'bg-amber-500/10 text-amber-300' },
  panic: { label: 'Panic', className: 'bg-down-soft text-down' },
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
export function FairValuePanel({
  market,
  fv,
  spot,
}: {
  market: ParsedMarket
  fv: FairValue
  spot: MarketSpot
}) {
  const calibration = useQuery({
    queryKey: qk.predictionCalibration,
    queryFn: getCalibration,
    refetchInterval: 60_000,
    staleTime: 55_000,
  })

  const pair = chainlinkPair(market.coin)
  const active = fv.confidence !== 'no-data' && !spot.completed && spot.strikePhase === 'locked'
  const ticks = useChainlinkHistory(
    active ? pair : null,
    Date.now() - VOL_LOOKBACK_MS[market.timeframe],
  )

  if (fv.confidence === 'no-data' || spot.completed || spot.strikePhase !== 'locked') {
    return null
  }

  const sigmaSeries = volSeries(ticks)

  const badge = CONFIDENCE_BADGE[fv.confidence]
  const edgePts = fv.edge != null ? fv.edge * 100 : null
  const stats = calibration.data

  // How far the regime-σ model pulls P(Up) away from the flat model. Zero in a
  // calm/normal regime (the two σ estimates agree) — the split only opens up
  // when recent vol departs from the window baseline.
  const regimeDeltaPts =
    fv.regimeP != null && fv.modelP != null ? (fv.regimeP - fv.modelP) * 100 : null
  const regimeAligned = regimeDeltaPts != null && Math.abs(regimeDeltaPts) < 0.1

  // Prefer the matched A/B (flat/reg/mkt over the same regime-carrying samples);
  // fall back to the all-sample headline until regime samples accrue.
  const hasRegimeBrier = stats?.brierRegime != null && stats?.brierModelPaired != null
  const brierFlat = hasRegimeBrier ? stats!.brierModelPaired : stats?.brierModel ?? null
  const brierMkt = hasRegimeBrier ? stats!.brierMarketPaired : stats?.brierMarket ?? null

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
        <span className="flex items-center gap-1.5">
          {fv.regime && (
            <span
              className={cn(
                'rounded-md px-1.5 py-0.5 text-[0.65rem] font-semibold',
                REGIME_BADGE[fv.regime].className,
              )}
              title={
                fv.regimeRatio != null
                  ? `Vol regime — fast σ is ${fv.regimeRatio.toFixed(2)}× its baseline`
                  : 'Vol regime'
              }
            >
              {REGIME_BADGE[fv.regime].label}
            </span>
          )}
          <span className={cn('rounded-md px-1.5 py-0.5 text-[0.65rem] font-semibold', badge.className)}>
            {badge.label}
          </span>
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

      {fv.regimeP != null && regimeDeltaPts != null && (
        <p className="text-center text-[0.65rem] text-muted-foreground">
          Regime σ{fv.regime ? ` (${REGIME_BADGE[fv.regime].label.toLowerCase()})` : ''}:{' '}
          <span className="font-semibold tabular-nums text-foreground">{formatPercent(fv.regimeP)}</span> Up ·{' '}
          {regimeAligned ? (
            <span>matches flat</span>
          ) : (
            <span className={cn('font-medium tabular-nums', regimeDeltaPts > 0 ? 'text-up' : 'text-down')}>
              {regimeDeltaPts > 0 ? '+' : ''}
              {regimeDeltaPts.toFixed(1)} pts vs flat
            </span>
          )}
        </p>
      )}

      {fv.signal && (
        <p className="rounded-lg bg-primary/10 px-3 py-2 text-center text-xs font-medium text-primary">
          Model sees <span className="font-semibold">{fv.signal === 'up' ? 'Up' : 'Down'}</span> underpriced —{' '}
          {formatPercent(fv.signal === 'up' ? fv.modelP! : 1 - fv.modelP!)} fair vs{' '}
          {formatPercent(fv.signal === 'up' ? fv.marketP! : 1 - fv.marketP!)} market
        </p>
      )}

      <div className="flex items-center justify-between gap-2 text-[0.65rem] text-muted-foreground">
        <span className="flex items-center gap-2">
          <VolSparkline values={sigmaSeries} />
          {fv.volPerMinPct != null ? (
            <>
              σ {formatVolPct(fv.volPerMinPct)}/min · window σ {fv.sigmaWindowPct != null ? formatVolPct(fv.sigmaWindowPct) : '—'}
            </>
          ) : (
            'Measuring realized volatility…'
          )}
        </span>
        <span className="flex items-center gap-1.5">
          {stats && stats.samples > 0 && brierFlat != null && brierMkt != null && (
            <span
              title={
                hasRegimeBrier
                  ? `Matched over ${stats.regimeSamples} regime samples · lower is better`
                  : `${stats.scoredWindows} scored windows · ${stats.samples} samples · lower is better`
              }
            >
              Brier {brierFlat.toFixed(3)}
              {hasRegimeBrier && (
                <>
                  {' '}
                  · reg{' '}
                  <span
                    className={cn(
                      stats.brierRegime! < brierFlat ? 'text-up' : stats.brierRegime! > brierFlat ? 'text-down' : undefined,
                    )}
                  >
                    {stats.brierRegime!.toFixed(3)}
                  </span>
                </>
              )}{' '}
              · mkt {brierMkt.toFixed(3)}
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

/** Passive per-minute σ trend — "is vol spiking right now vs. ten minutes ago". */
function VolSparkline({ values }: { values: number[] }) {
  if (values.length < 3) return null
  const w = 84
  const h = 20
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || hi || 1
  const px = (i: number) => 1 + (i / (values.length - 1)) * (w - 5)
  const py = (v: number) => h - 2 - ((v - lo) / span) * (h - 4)
  const points = values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ')
  const last = values[values.length - 1]
  return (
    <svg
      width={w}
      height={h}
      className="shrink-0"
      role="img"
      aria-label="Per-minute realized volatility trend"
    >
      <polyline points={points} fill="none" stroke="var(--muted-foreground)" strokeWidth="1.5" opacity="0.7" />
      <circle cx={px(values.length - 1)} cy={py(last)} r="2" fill="var(--primary)" />
    </svg>
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
