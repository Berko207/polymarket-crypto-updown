import { quoteToPrice, type TokenQuote } from './clobSocket'
import type { Position } from './api'

export interface PositionLiveStats {
  livePrice: number | null
  liveValue: number | null
  costBasis: number | null
  pnl: number | null
  pnlPct: number | null
}

/**
 * Best live mark for a position: the token's live bid (what you'd actually sell
 * into) first, then the live mid/last from the book, and only as a last resort the
 * polled snapshot price. Consulting the whole live quote — not just `bestBid` —
 * keeps the value ticking when the bid momentarily clears, instead of freezing on
 * the 30s-polled `currentPrice`.
 */
export function livePositionMark(position: Position, quote?: TokenQuote): number | null {
  const bid = quote?.bestBid
  if (bid != null && bid > 0) return bid
  const live = quoteToPrice(quote)
  if (live != null && live > 0) return live
  if (position.currentPrice > 0) return position.currentPrice
  return null
}

export function computePositionLiveStats(
  position: Position,
  livePrice: number | null,
): PositionLiveStats {
  const price = livePrice
  const liveValue = price != null ? position.size * price : position.currentValue ?? null

  // Cost basis from avgPrice × current size first: it's per-share, so it stays
  // consistent with the live size through partial sells and lets the live P&L branch
  // fire reliably — falling back to the indexed initialValue only if avgPrice is absent.
  const costBasis =
    position.avgPrice > 0
      ? position.size * position.avgPrice
      : position.initialValue != null && position.initialValue > 0
        ? position.initialValue
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
