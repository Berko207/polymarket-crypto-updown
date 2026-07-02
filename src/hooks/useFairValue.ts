import { useEffect, useRef } from 'react'
import { chainlinkSocket } from '@/lib/chainlinkSocket'
import { chainlinkPair } from '@/lib/cryptoPrice'
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
} from '@/lib/fairValue'
import { logOutcome, logSample } from '@/lib/predictionLog'
import { marketWindowKey } from '@/lib/marketScope'
import { useNow } from '@/hooks/useNow'
import type { MarketSpot } from '@/hooks/useMarketSpot'
import type { CoinId, ParsedMarket, TimeframeId } from '@/lib/types'

/** Persist a model-vs-market sample at most this often. */
const SAMPLE_EVERY_MS = 10_000

export interface FairValue {
  /** Model P(Up) — Φ(d₂) from realized Chainlink vol. */
  modelP: number | null
  /** Order-book P(Up) (live mid). */
  marketP: number | null
  /** modelP − marketP; positive means the book underprices Up. */
  edge: number | null
  /** Realized σ per minute, in % (regime readout). */
  volPerMinPct: number | null
  /** σ over the remaining window, in % (how much the price can still plausibly move). */
  sigmaWindowPct: number | null
  confidence: FairValueConfidence
  /** Side the book underprices when the edge is actionable and the model trusted. */
  signal: 'up' | 'down' | null
}

const EMPTY: FairValue = {
  modelP: null,
  marketP: null,
  edge: null,
  volPerMinPct: null,
  sigmaWindowPct: null,
  confidence: 'no-data',
  signal: null,
}

/**
 * Live fair-value estimate for the focused window, recomputed each second.
 * Also feeds the prediction log: one sample every {@link SAMPLE_EVERY_MS} while
 * the window runs, one outcome row when it resolves — so Brier calibration of
 * model vs. market accumulates in the background.
 */
interface SampledWindow {
  windowKey: string
  eventSlug: string
  coin: CoinId
  timeframe: TimeframeId
  strike: number
  endMs: number
  pair: string
}

export function useFairValue(market: ParsedMarket | null, spot: MarketSpot): FairValue {
  const now = useNow()
  const lastSampleRef = useRef(0)
  const outcomeLoggedRef = useRef<string | null>(null)
  /** Last window we sampled — lets the outcome be backfilled from the Chainlink
   * boundary tick if the rollover replaced the market before a "final" render. */
  const sampledWindowRef = useRef<SampledWindow | null>(null)

  const pair = market ? chainlinkPair(market.coin) : null
  const locked = spot.strikePhase === 'locked'
  const endMs = market?.endDate.getTime() ?? 0
  const msRemaining = endMs - now

  let value = EMPTY
  if (market && pair) {
    const ticks = chainlinkSocket.ticksSince(pair, now - VOL_LOOKBACK_MS[market.timeframe])
    const rv = realizedVol(ticks)

    const marketP = Number.isFinite(market.upPrice) ? market.upPrice : null
    const spread =
      market.bestBidUp != null && market.bestAskUp != null
        ? market.bestAskUp - market.bestBidUp
        : null

    const modelP =
      locked && !spot.completed && spot.strike != null && spot.current != null && rv
        ? probabilityUp(spot.current, spot.strike, rv.varPerMs, msRemaining)
        : null

    let confidence: FairValueConfidence
    if (!rv || rv.tickCount < MIN_VOL_TICKS || rv.spanMs < MIN_VOL_SPAN_MS) {
      confidence = 'low-sample'
    } else if (now - rv.lastTickMs > STALE_TICK_MS) {
      confidence = 'stale'
    } else if (spread == null || spread > MAX_TRUSTED_SPREAD) {
      confidence = 'wide-spread'
    } else {
      confidence = 'ok'
    }

    const edge = modelP != null && marketP != null ? modelP - marketP : null
    const signal =
      confidence === 'ok' && edge != null && Math.abs(edge) >= ACTIONABLE_EDGE
        ? edge > 0
          ? ('up' as const)
          : ('down' as const)
        : null

    const sigmaWindow =
      rv && msRemaining > 0 ? Math.sqrt(rv.varPerMs * msRemaining) : null

    value = {
      modelP,
      marketP,
      edge,
      volPerMinPct: rv ? Math.sqrt(rv.varPerMs * 60_000) * 100 : null,
      sigmaWindowPct: sigmaWindow != null ? sigmaWindow * 100 : null,
      confidence,
      signal,
    }
  }

  // Logging reads the freshest render state from a ref so effects can key on
  // narrow triggers without dep churn.
  const stateRef = useRef({ market, spot, value, locked, msRemaining, pair })
  stateRef.current = { market, spot, value, locked, msRemaining, pair }

  // Direct outcome capture, keyed on the condition itself: the completed market
  // is only retained for a sub-second blip during rollover, so a clock-tick
  // effect loses the race — this fires the moment the "final" render commits.
  const outcomeKey =
    market &&
    spot.completed &&
    spot.currentPhase === 'final' &&
    spot.strike != null &&
    spot.current != null
      ? marketWindowKey(market)
      : null

  useEffect(() => {
    if (!outcomeKey || outcomeLoggedRef.current === outcomeKey) return
    const { market, spot } = stateRef.current
    if (!market || spot.strike == null || spot.current == null) return
    outcomeLoggedRef.current = outcomeKey
    logOutcome({
      windowKey: outcomeKey,
      eventSlug: market.eventSlug,
      coin: market.coin,
      timeframe: market.timeframe,
      strike: spot.strike,
      finalPrice: spot.current,
      outcome: spot.current > spot.strike ? 'up' : 'down',
      endMs: market.endDate.getTime(),
      recordedAt: Date.now(),
    })
    if (sampledWindowRef.current?.windowKey === outcomeKey) sampledWindowRef.current = null
  }, [outcomeKey])

  useEffect(() => {
    const { market, spot, value, locked, msRemaining, pair } = stateRef.current

    // Backfill: a sampled window ended without its final render being observed.
    // Its resolution price is the Chainlink tick at the end boundary (the same
    // tick the next window locks as its strike), so reconstruct after the fact.
    // logOutcome puts by windowKey — a duplicate with the direct path is benign.
    const sampled = sampledWindowRef.current
    if (sampled && Date.now() > sampled.endMs + 2_000) {
      const finalPrice = chainlinkSocket.firstPriceAtOrAfter(sampled.pair, sampled.endMs, 120_000)
      if (finalPrice != null) {
        logOutcome({
          windowKey: sampled.windowKey,
          eventSlug: sampled.eventSlug,
          coin: sampled.coin,
          timeframe: sampled.timeframe,
          strike: sampled.strike,
          finalPrice,
          outcome: finalPrice > sampled.strike ? 'up' : 'down',
          endMs: sampled.endMs,
          recordedAt: Date.now(),
        })
        sampledWindowRef.current = null
      } else if (Date.now() > sampled.endMs + 150_000) {
        sampledWindowRef.current = null // boundary tick never arrived; stop retrying
      }
    }

    if (
      !market ||
      !pair ||
      !locked ||
      spot.completed ||
      msRemaining <= 0 ||
      value.modelP == null ||
      value.marketP == null ||
      spot.strike == null ||
      spot.current == null
    ) {
      return
    }
    if (now - lastSampleRef.current < SAMPLE_EVERY_MS) return
    lastSampleRef.current = now

    const windowKey = marketWindowKey(market)
    logSample({
      windowKey,
      eventSlug: market.eventSlug,
      coin: market.coin,
      timeframe: market.timeframe,
      t: now,
      msRemaining,
      spot: spot.current,
      strike: spot.strike,
      modelP: value.modelP,
      marketP: value.marketP,
      upBid: market.bestBidUp,
      upAsk: market.bestAskUp,
      sigmaWindow: value.sigmaWindowPct != null ? value.sigmaWindowPct / 100 : 0,
      confidence: value.confidence,
    })
    if (sampledWindowRef.current?.windowKey !== windowKey) {
      sampledWindowRef.current = {
        windowKey,
        eventSlug: market.eventSlug,
        coin: market.coin,
        timeframe: market.timeframe,
        strike: spot.strike,
        endMs: market.endDate.getTime(),
        pair,
      }
    }
  }, [now])

  return value
}
