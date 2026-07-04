/**
 * Entry strategy — deliberately the dashboard's edge signal, fired LATE
 * (~T-10s per the operator's steer): once per window, when a fresh, confident,
 * non-panic model edge clears the threshold, buy the underpriced side. Late
 * entry trades accuracy for price (the book has largely resolved by T-10s).
 */
import type { BotConfig } from '../config'
import type { Prediction } from './predict'
import type { ParsedMarket } from '../../src/lib/types'

export interface Order {
  side: 'up' | 'down'
  stakeUsd: number
  /** Ref book price: the paper fill (dry) and the FAK limit hint (live). */
  fillPrice: number
  /** CLOB token for the chosen side (live). */
  tokenId: string
  tickSize: number | null
  negRisk: boolean | null
}

/** Best available buy price for a side: the ask, else the gamma outcome price. */
function buyPrice(market: ParsedMarket, side: 'up' | 'down'): number {
  const ask = side === 'up' ? market.bestAskUp : market.bestAskDown
  const mid = side === 'up' ? market.upPrice : market.downPrice
  return ask ?? (Number.isFinite(mid) ? mid : 0.5)
}

/** Returns the intended order, or null when no entry is warranted this tick. */
export function decideEntry(
  pred: Prediction,
  market: ParsedMarket,
  config: BotConfig,
  now: number,
): Order | null {
  const msRemaining = market.endDate.getTime() - now
  const entryMaxMs = (config.entryAtSec + config.entryToleranceSec) * 1_000
  // Fire late: inside [2s floor, ~T-(10+tol)s]; never in the final sub-2s blip.
  if (msRemaining > entryMaxMs || msRemaining < 2_000) return null
  if (pred.confidence !== 'ok') return null
  if (pred.regime === 'panic') return null
  if (Math.abs(pred.edge) < config.edgeThreshold) return null

  const side: 'up' | 'down' = pred.edge > 0 ? 'up' : 'down'
  const fillPrice = buyPrice(market, side)
  if (!(fillPrice > 0 && fillPrice < 1)) return null
  const tokenId = side === 'up' ? market.upTokenId : market.downTokenId
  if (!tokenId) return null
  return {
    side,
    stakeUsd: config.stakeUsd,
    fillPrice,
    tokenId,
    tickSize: market.tickSize,
    negRisk: market.negRisk,
  }
}
