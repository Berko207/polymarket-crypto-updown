/**
 * Digital-option fair value for up/down windows.
 *
 * Each window is a binary option: Up pays $1 when the resolution price at close
 * beats the strike locked at open. Under a driftless lognormal (drift over
 * minutes is basis points while vol is percent-level, so σ carries all the
 * sensitivity):
 *
 *   P(Up) = Φ(d₂),  d₂ = [ln(S/K) − ½σ²T] / (σ√T)
 *
 * σ²T comes from realized variance of recent Chainlink ticks scaled to the time
 * remaining. Comparing Φ(d₂) to the order-book mid surfaces mispricings.
 */

import type { ChainlinkTick } from './chainlinkSocket'
import type { TimeframeId } from './types'

/** Trailing spans for realized-vol estimation — recent enough to track regime
 * shifts, long enough for a stable estimate at each window length. */
export const VOL_LOOKBACK_MS: Record<TimeframeId, number> = {
  '5m': 10 * 60_000,
  '15m': 20 * 60_000,
  '1h': 45 * 60_000,
  '4h': 2 * 60 * 60_000,
  daily: 4 * 60 * 60_000,
}

/** Model vs. market gap (in probability) worth flagging. */
export const ACTIONABLE_EDGE = 0.05
/** Below this many fresh ticks (or span) the σ estimate is noise. */
export const MIN_VOL_TICKS = 20
export const MIN_VOL_SPAN_MS = 60_000
/** No fresh oracle tick for this long → treat the model as stale. */
export const STALE_TICK_MS = 30_000
/** Book spread beyond this → the "market price" itself is too fuzzy to trade against. */
export const MAX_TRUSTED_SPREAD = 0.06

export type FairValueConfidence = 'ok' | 'low-sample' | 'stale' | 'wide-spread' | 'no-data'

export interface RealizedVol {
  /** Variance of log price per millisecond. */
  varPerMs: number
  tickCount: number
  spanMs: number
  lastTickMs: number
}

/**
 * Realized variance from irregularly-spaced ticks: sum of squared log returns
 * over elapsed time. Carried-forward RTDS re-emits are skipped — they are not
 * fresh observations and would silently deflate σ.
 */
export function realizedVol(ticks: ChainlinkTick[]): RealizedVol | null {
  let prev: ChainlinkTick | null = null
  let sumSq = 0
  let returns = 0
  let firstMs = 0
  let lastMs = 0

  for (const tick of ticks) {
    if (tick.carried || !(tick.value > 0)) continue
    if (prev) {
      const r = Math.log(tick.value / prev.value)
      sumSq += r * r
      returns += 1
    } else {
      firstMs = tick.timestamp
    }
    prev = tick
    lastMs = tick.timestamp
  }

  const spanMs = lastMs - firstMs
  if (returns < 1 || spanMs <= 0) return null
  return { varPerMs: sumSq / spanMs, tickCount: returns + 1, spanMs, lastTickMs: lastMs }
}

/**
 * Per-minute realized σ (fraction) bucketed over the tick span — the vol-regime
 * sparkline series. The trailing partial bucket is scaled up by elapsed time so
 * it doesn't read as a fake calm-down.
 */
export function volSeries(ticks: ChainlinkTick[], bucketMs = 60_000): number[] {
  const buckets = new Map<number, { sumSq: number; firstMs: number; lastMs: number }>()
  let prev: ChainlinkTick | null = null

  for (const tick of ticks) {
    if (tick.carried || !(tick.value > 0)) continue
    if (prev) {
      const key = Math.floor(tick.timestamp / bucketMs)
      const r = Math.log(tick.value / prev.value)
      const b = buckets.get(key)
      if (b) {
        b.sumSq += r * r
        b.lastMs = tick.timestamp
      } else {
        buckets.set(key, { sumSq: r * r, firstMs: tick.timestamp, lastMs: tick.timestamp })
      }
    }
    prev = tick
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b)
  return keys.map((key, i) => {
    const b = buckets.get(key)!
    if (i < keys.length - 1) return Math.sqrt(b.sumSq)
    const elapsed = Math.max(b.lastMs - key * bucketMs, bucketMs / 6)
    return Math.sqrt((b.sumSq * bucketMs) / elapsed)
  })
}

/** Φ for the standard normal (Zelen & Severo 26.2.17, |ε| < 7.5e-8). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const density = 0.3989422804014327 * Math.exp((-x * x) / 2)
  const poly =
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const tail = density * poly
  return x >= 0 ? 1 - tail : tail
}

/** P(price at window close > strike) under driftless lognormal diffusion. */
export function probabilityUp(
  spot: number,
  strike: number,
  varPerMs: number,
  msRemaining: number,
): number | null {
  if (!(spot > 0) || !(strike > 0)) return null
  if (msRemaining <= 0 || !(varPerMs > 0)) {
    return spot > strike ? 1 : spot < strike ? 0 : 0.5
  }
  const sigmaT = Math.sqrt(varPerMs * msRemaining)
  if (sigmaT < 1e-9) return spot > strike ? 1 : spot < strike ? 0 : 0.5
  const d2 = (Math.log(spot / strike) - (sigmaT * sigmaT) / 2) / sigmaT
  return normCdf(d2)
}
