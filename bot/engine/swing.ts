/**
 * Swing-scalp strategy — the counterpart to the late-window value bet in
 * strategy.ts. It always buys the side the fair-value model UNDERPRICES (edge =
 * model − market), holds for a few cents, and auto-exits on take-profit / stop /
 * edge-decay / regime-panic / time-stop.
 *
 * Two entry triggers (config.swingTrigger):
 *  - 'edge' (trust the model): enter as soon as |edge| ≥ swingEdgeMin, whatever
 *    opened the gap — the model moving OR the market moving. Doesn't wait for a
 *    spike, so it catches model-driven edges the strict fade misses.
 *  - 'move' (fade only): additionally require a market spike ≥ swingMovePts that
 *    this trade is fading — fewer, spike-confirmed entries (the original behavior).
 *
 * The edge is measured against the flat, regime, or blended fair value
 * (config.signalSource), so the operator can lean on the regime model where it's
 * likely more accurate (elevated/panic vol).
 *
 * Book note: the bot only gets the Up book from gamma (bestBidUp/bestAskUp); the
 * Down book is derived by complement (up + down = 1). We always BUY at the ask and
 * mark/SELL at the bid, so paper P&L pays the real spread on both legs.
 */
import type { BotConfig, SignalSource } from '../config'
import type { Prediction } from './predict'
import type { Order } from './strategy'
import type { ParsedMarket } from '../../src/lib/types'

export interface Book {
  upBid: number | null
  upAsk: number | null
  downBid: number | null
  downAsk: number | null
}

/** Derive both sides' top-of-book from gamma's Up book via the binary complement. */
export function deriveBook(market: ParsedMarket): Book {
  const upBid = market.bestBidUp
  const upAsk = market.bestAskUp
  return {
    upBid,
    upAsk,
    downBid: upAsk != null ? 1 - upAsk : null, // sell Down ↔ the Up ask side
    downAsk: upBid != null ? 1 - upBid : null,
  }
}

/** Price to BUY a side (cross the spread up). */
export function askForSide(book: Book, side: 'up' | 'down'): number | null {
  return side === 'up' ? book.upAsk : book.downAsk
}

/** Price to SELL a side (cross the spread down) — the mark for an open position. */
export function bidForSide(book: Book, side: 'up' | 'down'): number | null {
  return side === 'up' ? book.upBid : book.downBid
}

/** A recorded market mid at a point in time, for swing detection. */
export interface MidPoint {
  t: number
  mid: number
}

const clampProb = (p: number): number => Math.min(0.99, Math.max(0.01, p))

/** Fair-value probability for the configured source (falls back to flat if regimeP absent). */
export function sourceProb(pred: Prediction, source: SignalSource): number {
  if (source === 'regime' && pred.regimeP != null) return pred.regimeP
  if (
    source === 'blend' &&
    pred.regimeP != null &&
    (pred.regime === 'elevated' || pred.regime === 'panic')
  ) {
    return pred.regimeP
  }
  return pred.modelP
}

/** Signed edge (Up perspective) for the configured source: >0 ⇒ Up underpriced. */
export function sourceEdge(pred: Prediction, source: SignalSource): number {
  return sourceProb(pred, source) - pred.marketP
}

/**
 * Returns the intended entry order, or null when no entry is warranted.
 * `history` is this window's recent mids (oldest→newest, current appended) — used
 * only by the 'move' trigger.
 */
export function decideSwingEntry(
  pred: Prediction,
  market: ParsedMarket,
  history: MidPoint[],
  config: BotConfig,
  now: number,
): Order | null {
  const msRemaining = market.endDate.getTime() - now
  // Need room to realize the scalp: skip the time-stop tail and the settle blip.
  if (msRemaining <= (config.swingTimeStopSec + 5) * 1_000) return null
  if (pred.confidence !== 'ok') return null
  if (pred.regime === 'panic') return null

  // Always buy the side the model underprices; require the edge to clear the bar.
  const edge = sourceEdge(pred, config.signalSource)
  if (Math.abs(edge) < config.swingEdgeMin) return null
  const side: 'up' | 'down' = edge > 0 ? 'up' : 'down'

  // 'move' trigger: additionally require a market spike this trade is fading — the
  // market must have moved AGAINST our side by ≥ swingMovePts over the lookback.
  if (config.swingTrigger === 'move') {
    const cutoff = now - config.swingWindowSec * 1_000
    const past = history.find((p) => p.t >= cutoff) ?? history[0]
    if (!past) return null
    const move = pred.marketP - past.mid // + = Up richened, − = Up cheapened
    const fadesSpike =
      (side === 'down' && move >= config.swingMovePts) ||
      (side === 'up' && move <= -config.swingMovePts)
    if (!fadesSpike) return null
  }

  const ask = askForSide(deriveBook(market), side)
  if (!(ask != null && ask > 0 && ask < 1)) return null
  const tokenId = side === 'up' ? market.upTokenId : market.downTokenId
  if (!tokenId) return null
  return {
    side,
    stakeUsd: config.stakeUsd,
    fillPrice: ask,
    tokenId,
    tickSize: market.tickSize,
    negRisk: market.negRisk,
  }
}

export type ExitReason = 'take-profit' | 'stop-loss' | 'edge-gone' | 'regime-panic' | 'time-stop'

export interface OpenPosition {
  id: number
  side: 'up' | 'down'
  size: number
  /** Ask we paid at entry. */
  entryPrice: number
  /** Entry notional including the modeled entry fee. */
  cost: number
}

export interface ExitDecision {
  reason: ExitReason
  /** Price we'd sell at now (the side's bid, or a time-stop fallback). */
  mark: number
}

/** First exit condition that trips for an open position, or null to keep holding. */
export function decideExit(
  pos: OpenPosition,
  pred: Prediction,
  market: ParsedMarket,
  config: BotConfig,
  now: number,
): ExitDecision | null {
  const msRemaining = market.endDate.getTime() - now
  const timeUp = msRemaining <= config.swingTimeStopSec * 1_000
  const mark = bidForSide(deriveBook(market), pos.side)

  // No live bid: only force an exit at the time-stop, using the model-implied
  // price so we always close out rather than ride the binary to $0/$1.
  if (mark == null) {
    if (timeUp) {
      const implied = pos.side === 'up' ? pred.marketP : 1 - pred.marketP
      return { reason: 'time-stop', mark: clampProb(implied) }
    }
    return null
  }

  if (pred.regime === 'panic') return { reason: 'regime-panic', mark }
  if (mark - pos.entryPrice >= config.swingTakeProfitPts) return { reason: 'take-profit', mark }
  if (pos.entryPrice - mark >= config.swingStopLossPts) return { reason: 'stop-loss', mark }
  // The mispricing that justified the entry has (nearly) closed — bank the scalp.
  // Measured against the same source the entry used.
  const edge = sourceEdge(pred, config.signalSource)
  const edgeForSide = pos.side === 'up' ? edge : -edge
  if (edgeForSide <= config.swingExitEdge) return { reason: 'edge-gone', mark }
  if (timeUp) return { reason: 'time-stop', mark }
  return null
}
