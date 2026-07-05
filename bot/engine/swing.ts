/**
 * Swing-scalp strategy — the counterpart to the late-window value bet in
 * strategy.ts. It fires when the odds SWING (the market mid moves ≥ swingMovePts
 * over the last swingWindowSec) and the fair-value model says the move OVERSHOT
 * past fair value, then fades it: buy the side the swing made cheap, hold for a
 * few cents, and auto-exit on take-profit / stop / edge-decay / regime-panic /
 * time-stop. This matches the documented 5m/15m mean-reversion edge and only ever
 * takes a position when a fresh swing created a model-confirmed mispricing.
 *
 * Book note: the bot only gets the Up book from gamma (bestBidUp/bestAskUp); the
 * Down book is derived by complement (up + down = 1). We always BUY at the ask and
 * mark/SELL at the bid, so paper P&L pays the real spread on both legs.
 */
import type { BotConfig } from '../config'
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

/**
 * Returns the intended entry order, or null when no swing entry is warranted.
 * `history` is this window's recent mids (oldest→newest, current appended).
 */
export function decideSwingEntry(
  pred: Prediction,
  market: ParsedMarket,
  history: MidPoint[],
  config: BotConfig,
  now: number,
): Order | null {
  const msRemaining = market.endDate.getTime() - now
  // Need room for the fade to revert: skip the time-stop tail and the settle blip.
  if (msRemaining <= (config.swingTimeStopSec + 5) * 1_000) return null
  if (pred.confidence !== 'ok') return null
  if (pred.regime === 'panic') return null

  // Detect a swing: how far the mid moved over the lookback.
  const cutoff = now - config.swingWindowSec * 1_000
  const past = history.find((p) => p.t >= cutoff) ?? history[0]
  if (!past) return null
  const move = pred.marketP - past.mid // + = Up richened, − = Up cheapened
  if (Math.abs(move) < config.swingMovePts) return null

  // Fade the overshoot: buy the side the move made cheap...
  const side: 'up' | 'down' = move > 0 ? 'down' : 'up'
  // ...but only if the model agrees that side is now underpriced (the move pushed
  // price PAST fair value). edge = modelP − marketP(Up); flip it for the Down side.
  const edgeForSide = side === 'up' ? pred.edge : -pred.edge
  if (edgeForSide < config.swingEdgeMin) return null

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
  // The mispricing that justified the fade has (nearly) closed — bank the scalp.
  const edgeForSide = pos.side === 'up' ? pred.edge : -pred.edge
  if (edgeForSide <= config.swingExitEdge) return { reason: 'edge-gone', mark }
  if (timeUp) return { reason: 'time-stop', mark }
  return null
}
