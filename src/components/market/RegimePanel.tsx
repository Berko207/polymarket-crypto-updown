import { useQuery } from '@tanstack/react-query'
import { formatPercent } from '@/lib/polymarket'
import { chainlinkPair } from '@/lib/cryptoPrice'
import { getCalibration, type RegimeBucketStats } from '@/lib/predictionLog'
import { VOL_LOOKBACK_MS } from '@/lib/fairValue'
import { regimeHalfLives, regimeSeries, type VolRegime } from '@/lib/regime'
import { cn } from '@/lib/utils'
import { qk } from '@/queries/keys'
import { useChainlinkHistory } from '@/hooks/useChainlinkHistory'
import type { FairValue } from '@/hooks/useFairValue'
import type { MarketSpot } from '@/hooks/useMarketSpot'
import type { ParsedMarket } from '@/lib/types'

/** Label, chip class, and cell/accent color per regime. */
const REGIME_META: Record<VolRegime, { label: string; chip: string; cell: string; text: string }> = {
  calm: { label: 'Calm', chip: 'bg-up-soft text-up', cell: 'bg-up', text: 'text-up' },
  normal: {
    label: 'Normal',
    chip: 'bg-secondary text-muted-foreground',
    cell: 'bg-muted-foreground/40',
    text: 'text-muted-foreground',
  },
  elevated: {
    label: 'Elevated',
    chip: 'bg-amber-500/10 text-amber-300',
    cell: 'bg-amber-500',
    text: 'text-amber-300',
  },
  panic: { label: 'Panic', chip: 'bg-down-soft text-down', cell: 'bg-down', text: 'text-down' },
}

const REGIME_ORDER: VolRegime[] = ['calm', 'normal', 'elevated', 'panic']

/**
 * Regime experiment lab: the readable home for the regime-σ model vs the flat
 * model. Live P(Up) delta, a regime timeline, a matched Brier scoreboard, and a
 * per-regime breakdown — enough to actually decide whether regime-conditional σ
 * earns its keep. The A/B only means something over *divergent* (elevated/panic)
 * samples, so those are called out.
 */
export function RegimePanel({
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

  const active = fv.confidence !== 'no-data' && !spot.completed && spot.strikePhase === 'locked'
  const pair = chainlinkPair(market.coin)
  const lookback = VOL_LOOKBACK_MS[market.timeframe]
  const ticks = useChainlinkHistory(active ? pair : null, Date.now() - lookback)

  if (!active) return null

  const hl = regimeHalfLives(lookback)
  const series = regimeSeries(ticks, hl.fast, hl.slow)
  const stats = calibration.data

  const deltaPts =
    fv.regimeP != null && fv.modelP != null ? (fv.regimeP - fv.modelP) * 100 : null
  const aligned = deltaPts != null && Math.abs(deltaPts) < 0.1

  const matched = stats?.brierRegime != null && stats?.brierModelPaired != null
  const reg = stats?.brierRegime ?? null
  const flat = stats?.brierModelPaired ?? null
  // flat − reg: positive → regime is winning (lower Brier).
  const edge = matched ? flat! - reg! : null
  const divergent =
    (stats?.byRegime.elevated.samples ?? 0) + (stats?.byRegime.panic.samples ?? 0)

  const regimeMeta = fv.regime ? REGIME_META[fv.regime] : null

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/60 p-4">
      <div className="flex items-center justify-between">
        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
          Regime model <span className="font-normal opacity-70">· experiment</span>
        </p>
        {regimeMeta && (
          <span className={cn('rounded-md px-1.5 py-0.5 text-[0.65rem] font-semibold', regimeMeta.chip)}>
            {regimeMeta.label}
            {fv.regimeRatio != null && (
              <span className="ml-1 font-normal tabular-nums opacity-80">
                {fv.regimeRatio.toFixed(2)}×
              </span>
            )}
          </span>
        )}
      </div>

      {/* Live P(Up): regime vs flat */}
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">Regime P(Up)</span>
          <span className="text-2xl font-bold tabular-nums">
            {fv.regimeP != null ? formatPercent(fv.regimeP) : '—'}
          </span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">vs flat</span>
          {deltaPts == null ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : aligned ? (
            <span className="text-sm font-medium text-muted-foreground">matches flat</span>
          ) : (
            <span className={cn('text-sm font-bold tabular-nums', deltaPts > 0 ? 'text-up' : 'text-down')}>
              {deltaPts > 0 ? '+' : ''}
              {deltaPts.toFixed(1)} pts
            </span>
          )}
        </div>
      </div>

      {/* Timeline: regime over the lookback (bar height = σ_fast/σ_slow ratio) */}
      {series.length >= 3 && <RegimeTimeline series={series} lookbackMs={lookback} />}

      {/* Scoreboard */}
      <div className="rounded-lg bg-secondary px-3 py-2.5">
        {!matched ? (
          <p className="text-center text-[0.7rem] text-muted-foreground">
            Gathering matched samples… regime vs flat needs resolved windows logged on this build.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-3 tabular-nums">
                <span className={cn('font-bold', edge! > 0 ? 'text-up' : edge! < 0 ? 'text-down' : undefined)}>
                  reg {reg!.toFixed(3)}
                </span>
                <span className="text-muted-foreground">flat {flat!.toFixed(3)}</span>
              </span>
              <span
                className={cn(
                  'font-semibold',
                  edge! > 0.0005 ? 'text-up' : edge! < -0.0005 ? 'text-down' : 'text-muted-foreground',
                )}
              >
                {Math.abs(edge!) < 0.0005
                  ? 'dead heat'
                  : edge! > 0
                    ? `regime ahead ${edge!.toFixed(3)}`
                    : `flat ahead ${(-edge!).toFixed(3)}`}
              </span>
            </div>
            <p className="text-[0.65rem] text-muted-foreground">
              {stats!.regimeSamples} matched samples · lower Brier wins ·{' '}
              <span className={cn(divergent === 0 && 'text-amber-300')}>
                {divergent} divergent (elevated+panic)
              </span>
              {divergent === 0 && ' — all calm/normal so far, where reg ≈ flat by design'}
            </p>
          </div>
        )}
      </div>

      {/* Per-regime breakdown */}
      {matched && (
        <div className="flex flex-col gap-0.5">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-[0.6rem] uppercase tracking-wide text-muted-foreground">
            <span>Regime</span>
            <span className="text-right">n</span>
            <span className="text-right">flat</span>
            <span className="text-right">reg</span>
          </div>
          {REGIME_ORDER.map((r) => (
            <RegimeRow key={r} regime={r} stats={stats!.byRegime[r]} />
          ))}
        </div>
      )}
    </div>
  )
}

function RegimeRow({ regime, stats }: { regime: VolRegime; stats: RegimeBucketStats }) {
  const meta = REGIME_META[regime]
  const has = stats.samples > 0 && stats.brierModel != null && stats.brierRegime != null
  const regWins = has && stats.brierRegime! < stats.brierModel!
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 text-xs tabular-nums">
      <span className={cn('flex items-center gap-1.5', !has && 'opacity-45')}>
        <span className={cn('size-2 rounded-full', meta.cell)} />
        <span className={meta.text}>{meta.label}</span>
      </span>
      <span className="text-right text-muted-foreground">{stats.samples || '—'}</span>
      <span className="text-right text-muted-foreground">
        {stats.brierModel != null ? stats.brierModel.toFixed(3) : '—'}
      </span>
      <span
        className={cn(
          'text-right font-medium',
          !has ? 'text-muted-foreground' : regWins ? 'text-up' : 'text-down',
        )}
      >
        {stats.brierRegime != null ? stats.brierRegime.toFixed(3) : '—'}
      </span>
    </div>
  )
}

/** Colored bar strip: one bar per bucket, height ∝ σ_fast/σ_slow, color = regime. */
function RegimeTimeline({
  series,
  lookbackMs,
}: {
  series: { regime: VolRegime; ratio: number }[]
  lookbackMs: number
}) {
  const H = 26
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-[26px] items-end gap-[2px]" role="img" aria-label="Regime over time">
        {series.map((s, i) => {
          // Ratio ~0.5–2.5 maps to a readable bar; clamp so panic doesn't blow out.
          const h = Math.max(3, Math.min(H, (s.ratio / 2.5) * H))
          return (
            <div
              key={i}
              className={cn('flex-1 rounded-sm', REGIME_META[s.regime].cell)}
              style={{ height: `${h}px` }}
              title={`${REGIME_META[s.regime].label} · ${s.ratio.toFixed(2)}× baseline`}
            />
          )
        })}
      </div>
      <div className="flex justify-between text-[0.6rem] text-muted-foreground">
        <span>{Math.round(lookbackMs / 60_000)}m ago</span>
        <span>regime σ_fast / σ_slow · now</span>
      </div>
    </div>
  )
}
