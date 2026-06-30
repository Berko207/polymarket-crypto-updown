import { outcomeSide, type OutcomeSide } from '@/components/common/OutcomeBadge'
import { computePositionLiveStats, livePositionMark, type PositionLiveStats } from './positionPnl'
import type { TokenQuote } from './clobSocket'
import type { Position } from './api'
import { getTokenMarketLabel } from './tokenLabels'

export interface PositionLeg {
  position: Position
  side: OutcomeSide
  stats: PositionLiveStats
  canSell: boolean
}

export interface SellRecommendation {
  /** Which leg to exit first, if any. */
  first: OutcomeSide | null
  reason: string
}

export interface PairSummary {
  legCount: number
  totalCost: number | null
  totalValue: number | null
  netPnl: number | null
  netPnlPct: number | null
}

export function buildPositionLeg(position: Position, quote?: TokenQuote): PositionLeg {
  const side = outcomeSide(position.outcome)
  const livePrice = livePositionMark(position, quote)
  const stats = computePositionLiveStats(position, livePrice)
  const canSell =
    position.size >= 0.01 && quote?.bestBid != null && quote.bestBid > 0 && !position.redeemable
  return { position, side, stats, canSell }
}

/** Rank legs for exit: take profit on the winner first; otherwise sell the stronger bid. */
export function recommendSellFirst(legs: PositionLeg[]): SellRecommendation {
  const sellable = legs.filter((l) => l.canSell)
  if (sellable.length < 2) {
    return { first: null, reason: '' }
  }

  const scored = sellable.map((leg) => {
    const pnl = leg.stats.pnl ?? -Infinity
    const pnlPct = leg.stats.pnlPct ?? -Infinity
    const bid = leg.stats.livePrice ?? 0
    return { leg, pnl, pnlPct, bid }
  })

  const anyProfit = scored.some((s) => s.pnl > 0)
  if (anyProfit) {
    scored.sort((a, b) => b.pnlPct - a.pnlPct || b.pnl - a.pnl)
    const top = scored[0]
    const label = top.leg.side === 'up' ? 'Up' : 'Down'
    const pct = top.pnlPct > -Infinity ? `${top.pnlPct >= 0 ? '+' : ''}${top.pnlPct.toFixed(1)}%` : ''
    return {
      first: top.leg.side,
      reason: pct ? `Take profit on ${label} (${pct})` : `Take profit on ${label}`,
    }
  }

  scored.sort((a, b) => b.bid - a.bid || b.pnl - a.pnl)
  const top = scored[0]
  const label = top.leg.side === 'up' ? 'Up' : 'Down'
  return {
    first: top.leg.side,
    reason: `Better bid on ${label} — recover more USDC`,
  }
}

export function summarizePair(legs: PositionLeg[]): PairSummary {
  let totalCost = 0
  let totalValue = 0
  let hasCost = false
  let hasValue = false

  for (const leg of legs) {
    if (leg.stats.costBasis != null) {
      totalCost += leg.stats.costBasis
      hasCost = true
    }
    if (leg.stats.liveValue != null) {
      totalValue += leg.stats.liveValue
      hasValue = true
    }
  }

  const cost = hasCost ? totalCost : null
  const value = hasValue ? totalValue : null
  const netPnl = cost != null && value != null ? value - cost : null
  const netPnlPct = netPnl != null && cost != null && cost > 0 ? (netPnl / cost) * 100 : null

  return {
    legCount: legs.length,
    totalCost: cost,
    totalValue: value,
    netPnl,
    netPnlPct,
  }
}

/** Group positions that belong to the same market window. */
export function groupPositionsByMarket(positions: Position[]): Map<string, Position[]> {
  const groups = new Map<string, Position[]>()
  for (const p of positions) {
    const stored = getTokenMarketLabel(p.tokenId)
    const key = p.eventSlug || stored || `${p.title}:${p.tokenId}`
    const list = groups.get(key) ?? []
    list.push(p)
    groups.set(key, list)
  }
  return groups
}
