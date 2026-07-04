/**
 * Headless port of useFairValue's core: given the live market, the Chainlink
 * ticks, and the window strike/spot, produce the flat + regime P(Up) and the
 * confidence label. Same functions the browser uses, so predictions match.
 */
import {
  ACTIONABLE_EDGE,
  MAX_TRUSTED_SPREAD,
  MIN_VOL_SPAN_MS,
  MIN_VOL_TICKS,
  STALE_TICK_MS,
  VOL_LOOKBACK_MS,
  probabilityUp,
  realizedVol,
  type FairValueConfidence,
} from '../../src/lib/fairValue'
import { regimeHalfLives, regimeVol, type VolRegime } from '../../src/lib/regime'
import { marketWindowKey } from '../../src/lib/marketScope'
import type { ParsedMarket } from '../../src/lib/types'
import type { Tick } from '../sources/chainlink'

export interface Prediction {
  windowKey: string
  coin: string
  timeframe: string
  t: number
  msRemaining: number
  spot: number
  strike: number
  modelP: number
  regimeP: number | null
  regime: VolRegime | null
  regimeRatio: number | null
  marketP: number
  upBid: number | null
  upAsk: number | null
  sigmaWindow: number
  confidence: FairValueConfidence
  /** modelP − marketP; the signal the dry trader will act on in M2. */
  edge: number
  /** Side the book underprices when |edge| ≥ ACTIONABLE_EDGE and confidence ok. */
  signal: 'up' | 'down' | null
}

/**
 * Returns null when the window can't be scored yet (no vol estimate, no market
 * odds, or the window is over) — the recorder simply skips persisting it.
 */
export function predict(
  market: ParsedMarket,
  ticks: Tick[],
  strike: number,
  spot: number,
  now: number,
): Prediction | null {
  const msRemaining = market.endDate.getTime() - now
  if (msRemaining <= 0 || !(strike > 0) || !(spot > 0)) return null

  const lookbackTicks = ticks.filter((t) => t.timestamp >= now - VOL_LOOKBACK_MS[market.timeframe])
  const rv = realizedVol(lookbackTicks)
  const hl = regimeHalfLives(VOL_LOOKBACK_MS[market.timeframe])
  const rvRegime = regimeVol(lookbackTicks, hl.fast, hl.slow)

  const marketP = Number.isFinite(market.upPrice) ? market.upPrice : null
  if (marketP == null) return null

  const modelP = rv ? probabilityUp(spot, strike, rv.varPerMs, msRemaining) : null
  if (modelP == null) return null
  const regimeP = rvRegime ? probabilityUp(spot, strike, rvRegime.varPerMs, msRemaining) : null

  const spread =
    market.bestBidUp != null && market.bestAskUp != null
      ? market.bestAskUp - market.bestBidUp
      : null

  let confidence: FairValueConfidence
  if (!rv || rv.tickCount < MIN_VOL_TICKS || rv.spanMs < MIN_VOL_SPAN_MS) confidence = 'low-sample'
  else if (now - rv.lastTickMs > STALE_TICK_MS) confidence = 'stale'
  else if (spread == null || spread > MAX_TRUSTED_SPREAD) confidence = 'wide-spread'
  else confidence = 'ok'

  const edge = modelP - marketP
  const signal =
    confidence === 'ok' && Math.abs(edge) >= ACTIONABLE_EDGE ? (edge > 0 ? 'up' : 'down') : null

  return {
    windowKey: marketWindowKey(market),
    coin: market.coin,
    timeframe: market.timeframe,
    t: now,
    msRemaining,
    spot,
    strike,
    modelP,
    regimeP,
    regime: rvRegime?.regime ?? null,
    regimeRatio: rvRegime?.ratio ?? null,
    marketP,
    upBid: market.bestBidUp,
    upAsk: market.bestAskUp,
    sigmaWindow: rv && msRemaining > 0 ? Math.sqrt(rv.varPerMs * msRemaining) : 0,
    confidence,
    edge,
    signal,
  }
}
