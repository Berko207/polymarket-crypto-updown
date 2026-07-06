/**
 * Value entry — once per window, when a confident non-panic model edge clears
 * the threshold and the chosen side's ask is cheap enough (asymmetric upside).
 * Fires any time in the window (not last 2s); hold to settlement.
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

/** Shared entry gate — `reason` is set only when edge is live but something else blocks (for skip logs). */
function entryGate(
  pred: Prediction,
  market: ParsedMarket,
  config: BotConfig,
  now: number,
): { enter: true; side: 'up' | 'down'; fillPrice: number } | { enter: false; reason?: string } {
  const msRemaining = market.endDate.getTime() - now
  if (msRemaining < 2_000) return { enter: false }
  if (Math.abs(pred.edge) < config.edgeThreshold) return { enter: false }
  if (pred.confidence !== 'ok') return { enter: false, reason: `confidence ${pred.confidence}` }
  if (pred.regime === 'panic') return { enter: false, reason: 'regime panic' }
  const side: 'up' | 'down' = pred.edge > 0 ? 'up' : 'down'
  const fillPrice = buyPrice(market, side)
  if (!(fillPrice > 0 && fillPrice < 1)) {
    return { enter: false, reason: `no book price for ${side} (${fillPrice.toFixed(3)})` }
  }
  if (fillPrice > config.valueMaxEntryPrice) {
    return { enter: false, reason: `ask ${fillPrice.toFixed(3)} > max ${config.valueMaxEntryPrice}` }
  }
  const tokenId = side === 'up' ? market.upTokenId : market.downTokenId
  if (!tokenId) return { enter: false, reason: `missing ${side} tokenId` }
  return { enter: true, side, fillPrice }
}

/** Why entry is blocked when edge is live (null = would enter, or edge too weak to log). */
export function entryBlockReason(
  pred: Prediction,
  market: ParsedMarket,
  config: BotConfig,
  now: number,
): string | null {
  const gate = entryGate(pred, market, config, now)
  return gate.enter ? null : (gate.reason ?? null)
}

/** Returns the intended order, or null when no entry is warranted this tick. */
export function decideEntry(
  pred: Prediction,
  market: ParsedMarket,
  config: BotConfig,
  now: number,
): Order | null {
  const gate = entryGate(pred, market, config, now)
  if (!gate.enter) return null
  return {
    side: gate.side,
    stakeUsd: config.stakeUsd,
    fillPrice: gate.fillPrice,
    tokenId: (gate.side === 'up' ? market.upTokenId : market.downTokenId)!,
    tickSize: market.tickSize,
    negRisk: market.negRisk,
  }
}
