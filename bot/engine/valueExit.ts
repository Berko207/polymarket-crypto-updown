/**
 * Value strategy mid-window exits — hold-to-settle entries, but cut the position
 * when the fair-value model says winning is unlikely (late window) or vol spikes
 * into panic. Complements swing.ts (cent scalp) without changing value entries.
 */
import type { BotConfig } from '../config'
import type { Prediction } from './predict'
import { bidForSide, deriveBook, sourceProb, type OpenPosition } from './swing'
import type { ParsedMarket } from '../../src/lib/types'

export type ValueExitReason = 'low-prob' | 'regime-panic'

export interface ValueExitDecision {
  reason: ValueExitReason
  /** Bid we'd hit on a market sell (or model-implied fallback in panic with no bid). */
  mark: number
}

const clampProb = (p: number): number => Math.min(0.99, Math.max(0.01, p))

/** P(win) for the held side from the configured fair-value source. */
export function winProbForSide(pred: Prediction, side: 'up' | 'down', config: BotConfig): number {
  const pUp = sourceProb(pred, config.signalSource)
  return side === 'up' ? pUp : 1 - pUp
}

/**
 * First value exit that trips, or null to keep holding to settlement.
 * Low-prob cuts only fire inside the late window and after a min hold; panic is immediate.
 */
export function decideValueExit(
  pos: OpenPosition,
  pred: Prediction,
  market: ParsedMarket,
  config: BotConfig,
  now: number,
  entryT: number,
): ValueExitDecision | null {
  if (!config.valueExitEnabled) return null

  const msRemaining = market.endDate.getTime() - now
  if (msRemaining < 2_000) return null

  const mark = bidForSide(deriveBook(market), pos.side)

  if (pred.regime === 'panic') {
    const fallback =
      pos.side === 'up' ? pred.marketP : 1 - pred.marketP
    return { reason: 'regime-panic', mark: mark ?? clampProb(fallback) }
  }

  if (now - entryT < config.valueExitMinHoldSec * 1_000) return null
  if (msRemaining > config.valueExitWithinSec * 1_000) return null
  if (pred.confidence !== 'ok') return null

  const pWin = winProbForSide(pred, pos.side, config)
  if (pWin >= config.valueExitMinWinProb) return null
  if (!(mark != null && mark > 0)) return null

  return { reason: 'low-prob', mark }
}
