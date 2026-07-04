/**
 * Regime-aware volatility.
 *
 * realizedVol() weights a tick from eight minutes ago the same as one from five
 * seconds ago. But vol clusters — recent returns are far stronger evidence about
 * the next two minutes than old ones. This is a time-decayed realized variance:
 * realizedVol() with an exponential kernel instead of a boxcar, so the estimate
 * tracks the *current* vol regime rather than the flat-window average. It needs
 * no fitting (unlike a Baum-Welch HMM) — the deliberately cheap first cut of the
 * regime idea, kept behind the same Brier harness so we can tell if it helps.
 *
 * A fast and a slow kernel run together; the ratio of their σ labels the regime
 * (calm → panic) — the "which state am I in now" nowcast that feeds a risk gate
 * and a Brier A/B against the flat-window model.
 */

import type { ChainlinkTick } from './chainlinkSocket'

export type VolRegime = 'calm' | 'normal' | 'elevated' | 'panic'

/** Fast EWMA half-life as a fraction of the vol lookback — reacts to a spike
 * within a window while staying long enough to not chase single ticks. */
export const REGIME_FAST_FRACTION = 1 / 8
/** Slow EWMA half-life — the baseline the fast estimate is judged against. */
export const REGIME_SLOW_FRACTION = 1 / 2

/** σ_fast / σ_slow band edges. >1 means current vol exceeds its own baseline.
 * Provisional: fast and slow share the lookback, so the ratio is compressed
 * toward 1 (observed range ≈ 0.8–1.5 in normal chop). Retune from the logged
 * ratio distribution once enough windows accrue — the labels are a readout, the
 * Brier A/B rides on `varPerMs`, not these thresholds. */
const CALM_MAX = 0.85
const NORMAL_MAX = 1.25
const ELEVATED_MAX = 1.8

export interface RegimeVol {
  /** Fast (regime-conditional) EWMA variance of log price per ms — feeds Φ(d₂). */
  varPerMs: number
  /** Slow baseline EWMA variance per ms. */
  baselineVarPerMs: number
  /** σ_fast / σ_slow — how stretched current vol is vs its baseline. */
  ratio: number
  regime: VolRegime
  tickCount: number
  spanMs: number
  lastTickMs: number
}

function classify(ratio: number): VolRegime {
  if (ratio <= CALM_MAX) return 'calm'
  if (ratio <= NORMAL_MAX) return 'normal'
  if (ratio <= ELEVATED_MAX) return 'elevated'
  return 'panic'
}

/**
 * Time-decayed realized variance from irregularly-spaced ticks. Each squared log
 * return and its elapsed interval are weighted by exp(-age·ln2/halflife), with
 * age measured back from the most recent tick, so recent returns dominate.
 * Weighting numerator (Σr²) and denominator (Σdt) by the same kernel keeps it a
 * proper variance-per-ms and collapses to realizedVol() as halflife → ∞.
 *
 * Carried-forward RTDS re-emits are skipped for the same reason realizedVol()
 * skips them — they are not fresh observations and would deflate σ.
 */
export function regimeVol(
  ticks: ChainlinkTick[],
  fastHalfLifeMs: number,
  slowHalfLifeMs: number,
): RegimeVol | null {
  if (!(fastHalfLifeMs > 0) || !(slowHalfLifeMs > 0)) return null
  const fastLambda = Math.LN2 / fastHalfLifeMs
  const slowLambda = Math.LN2 / slowHalfLifeMs

  const rows: { rr: number; dt: number; endMs: number }[] = []
  let prev: ChainlinkTick | null = null
  let firstMs = 0
  let lastMs = 0

  for (const tick of ticks) {
    if (tick.carried || !(tick.value > 0)) continue
    if (prev) {
      const dt = tick.timestamp - prev.timestamp
      if (dt > 0) {
        const r = Math.log(tick.value / prev.value)
        rows.push({ rr: r * r, dt, endMs: tick.timestamp })
      }
    } else {
      firstMs = tick.timestamp
    }
    prev = tick
    lastMs = tick.timestamp
  }
  if (rows.length < 1) return null

  const ref = lastMs
  let fastNum = 0
  let fastDen = 0
  let slowNum = 0
  let slowDen = 0
  for (const { rr, dt, endMs } of rows) {
    const age = ref - endMs
    const wf = Math.exp(-age * fastLambda)
    const ws = Math.exp(-age * slowLambda)
    fastNum += wf * rr
    fastDen += wf * dt
    slowNum += ws * rr
    slowDen += ws * dt
  }
  if (!(fastDen > 0) || !(slowDen > 0)) return null

  const varPerMs = fastNum / fastDen
  const baselineVarPerMs = slowNum / slowDen
  const ratio = baselineVarPerMs > 0 ? Math.sqrt(varPerMs / baselineVarPerMs) : 1
  return {
    varPerMs,
    baselineVarPerMs,
    ratio,
    regime: classify(ratio),
    tickCount: rows.length + 1,
    spanMs: lastMs - firstMs,
    lastTickMs: lastMs,
  }
}

/** Fast/slow EWMA half-lives derived from the flat-window vol lookback. */
export function regimeHalfLives(lookbackMs: number): { fast: number; slow: number } {
  return { fast: lookbackMs * REGIME_FAST_FRACTION, slow: lookbackMs * REGIME_SLOW_FRACTION }
}

/**
 * Per-bucket regime history for a timeline strip. Evaluates regimeVol at each
 * bucket boundary over the ticks up to that point, so each cell matches what the
 * live label would have read at that moment. O(buckets × ticks) — fine for a
 * memoized sparkline over a short lookback.
 */
export function regimeSeries(
  ticks: ChainlinkTick[],
  fastHalfLifeMs: number,
  slowHalfLifeMs: number,
  bucketMs = 60_000,
): { regime: VolRegime; ratio: number }[] {
  const usable = ticks.filter((t) => !t.carried && t.value > 0)
  if (usable.length < 2) return []
  const first = usable[0].timestamp
  const last = usable[usable.length - 1].timestamp
  const out: { regime: VolRegime; ratio: number }[] = []
  let idx = 0
  for (let b = Math.ceil(first / bucketMs) * bucketMs; b <= last; b += bucketMs) {
    while (idx < usable.length && usable[idx].timestamp <= b) idx += 1
    const rv = regimeVol(usable.slice(0, idx), fastHalfLifeMs, slowHalfLifeMs)
    if (rv) out.push({ regime: rv.regime, ratio: rv.ratio })
  }
  return out
}
