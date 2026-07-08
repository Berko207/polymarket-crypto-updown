/**
 * Easy/certainty exits — bank profit when the bid reaches the take-profit floor,
 * then try to free USDC after the window (sell into any bid, else redeem on live).
 */
import type { BotConfig } from '../config'
import type { Prediction } from './predict'
import { bidForSide, deriveBook } from './swing'
import type { ParsedMarket } from '../../src/lib/types'

export type CertaintyExitReason = 'take-profit' | 'window-end' | 'redeem'

export interface CertaintyExitDecision {
  reason: CertaintyExitReason
  mark: number
}

export interface OpenCertaintyPosition {
  id: number
  side: 'up' | 'down'
  size: number
  cost: number
  entryPrice: number
}

/** Sell when the bid clears the take-profit floor (default 99¢). */
export function decideCertaintyExit(
  pos: OpenCertaintyPosition,
  market: ParsedMarket,
  config: BotConfig,
  now: number,
  /** Live: prefer CLOB bid over gamma/complement (matches post-window sells). */
  markOverride?: number | null,
): CertaintyExitDecision | null {
  const msRemaining = market.endDate.getTime() - now
  if (msRemaining < 1_000) return null

  const mark = markOverride ?? bidForSide(deriveBook(market), pos.side)
  if (mark != null && mark >= config.certaintyTakeProfitBid) {
    return { reason: 'take-profit', mark }
  }
  return null
}

/** After the window, sell into any positive bid to recover USDC before redeem. */
export function decideCertaintyWindowEndExit(
  pos: OpenCertaintyPosition,
  market: ParsedMarket | null,
  minBid: number,
): CertaintyExitDecision | null {
  if (!market) return null
  const mark = bidForSide(deriveBook(market), pos.side)
  if (mark != null && mark >= minBid) {
    return { reason: 'window-end', mark }
  }
  return null
}

/** No-op placeholder so certainty scopes still run predict() while holding. */
export function certaintyExitPred(_pred: Prediction): void {}
