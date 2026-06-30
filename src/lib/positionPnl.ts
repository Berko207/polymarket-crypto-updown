import type { Position } from './api'

export interface PositionLiveStats {
  livePrice: number | null
  liveValue: number | null
  costBasis: number | null
  pnl: number | null
  pnlPct: number | null
}

export function livePriceForPosition(
  position: Position,
  bids: { up: number | null; down: number | null },
  mids?: { up: number | null; down: number | null },
  tokenBid?: number | null,
): number | null {
  if (tokenBid != null && tokenBid > 0) return tokenBid

  const outcome = position.outcome.toLowerCase()
  const bid = outcome === 'up' ? bids.up : outcome === 'down' ? bids.down : null
  if (bid != null && bid > 0) return bid

  const mid = outcome === 'up' ? mids?.up : outcome === 'down' ? mids?.down : null
  if (mid != null && mid > 0) return mid

  if (position.currentPrice > 0) return position.currentPrice
  return null
}

export function computePositionLiveStats(
  position: Position,
  livePrice: number | null,
): PositionLiveStats {
  const price = livePrice
  const liveValue =
    price != null ? position.size * price : position.currentValue != null ? position.currentValue : null

  const costBasis =
    position.initialValue != null && position.initialValue > 0
      ? position.initialValue
      : position.avgPrice > 0
        ? position.size * position.avgPrice
        : null

  let pnl: number | null = null
  let pnlPct: number | null = null

  if (liveValue != null && costBasis != null && costBasis > 0) {
    pnl = liveValue - costBasis
    pnlPct = (pnl / costBasis) * 100
  } else if (position.cashPnl != null) {
    pnl = position.cashPnl
    pnlPct = position.percentPnl ?? null
  }

  return { livePrice: price, liveValue, costBasis, pnl, pnlPct }
}

export function formatPnlUsd(pnl: number): string {
  const sign = pnl >= 0 ? '+' : '-'
  return `${sign}$${Math.abs(pnl).toFixed(2)}`
}

export function formatPnlPct(pnlPct: number): string {
  const sign = pnlPct >= 0 ? '+' : ''
  return `${sign}${pnlPct.toFixed(1)}%`
}
