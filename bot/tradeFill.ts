/**
 * Live fill normalization — CLOB making/taking amounts sometimes parse to absurd
 * entry prices (0.01, 0.07…) which inflates share count and settlement P&L.
 * All entry recording and settlement should go through these helpers.
 */

export const MIN_ENTRY_PRICE = 0.15
export const MAX_ENTRY_PRICE = 0.99

export interface FillAmounts {
  entryPrice: number
  size: number
  cost: number
}

export function entryPriceSuspicious(entryPrice: number): boolean {
  return !Number.isFinite(entryPrice) || entryPrice < MIN_ENTRY_PRICE || entryPrice >= MAX_ENTRY_PRICE
}

/** Share count from a stored row — prefers cost ÷ price when size disagrees. */
export function tradeShares(row: { size: number; cost: number; entryPrice: number }): number {
  const { size, cost, entryPrice } = row
  if (!(entryPrice > 0)) return size > 0 ? size : 0
  const fromCost = cost / entryPrice
  if (!(size > 0)) return fromCost
  const drift = Math.abs(size * entryPrice - cost)
  const tol = Math.max(0.02, cost * 0.05)
  if (drift <= tol) return size
  return fromCost
}

/** Typical entry anchor when repairing a corrupted historical row. */
export function typicalEntryPrice(strategy: string, cfgMaxAsk?: number | null): number {
  if (strategy === 'certainty') return Math.min(cfgMaxAsk ?? 0.92, 0.92)
  if (strategy === 'value') return 0.5
  return 0.5
}

/**
 * Normalize a live fill against the book price the strategy traded on and the
 * intended USDC stake. Returns null when the fill is unusable.
 */
export function normalizeLiveFill(
  stakeUsd: number,
  bookPrice: number,
  fillPrice: number,
  fillSize: number,
): FillAmounts | null {
  if (!(bookPrice > MIN_ENTRY_PRICE && bookPrice < MAX_ENTRY_PRICE) || !(stakeUsd > 0)) return null

  let price = fillPrice > 0 && fillPrice < 1 ? fillPrice : bookPrice
  let size = fillSize > 0 ? fillSize : stakeUsd / price
  let cost = price * size

  if (Math.abs(price - bookPrice) / bookPrice > 0.35 || entryPriceSuspicious(price)) {
    price = bookPrice
    size = stakeUsd / price
    cost = stakeUsd
  } else if (cost < stakeUsd * 0.9) {
    size = stakeUsd / price
    cost = stakeUsd
  } else if (Math.abs(cost - stakeUsd) > Math.max(0.05, stakeUsd * 0.15)) {
    size = stakeUsd / price
    cost = stakeUsd
  }

  if (entryPriceSuspicious(price) || !(size > 0) || !(cost > 0)) return null
  return { entryPrice: price, size, cost }
}

/** Repair stored live row amounts. Returns null when the row already looks sane. */
export function repairTradeAmounts(
  row: {
    entryPrice: number
    size: number
    cost: number
    strategy: string
    cfgMaxAsk?: number | null
  },
  stakeUsd: number,
): FillAmounts | null {
  const { strategy, cfgMaxAsk } = row
  let { entryPrice, size, cost } = row
  const targetCost = cost >= stakeUsd * 0.5 ? cost : stakeUsd
  const maxShares = targetCost / MIN_ENTRY_PRICE
  const shares = tradeShares({ size, cost, entryPrice })

  const needsRepair =
    entryPriceSuspicious(entryPrice) ||
    shares > maxShares * 1.05 ||
    Math.abs(shares * entryPrice - targetCost) > Math.max(0.05, targetCost * 0.1)

  if (!needsRepair) return null

  let price = entryPrice
  if (entryPriceSuspicious(price)) {
    if (size > 0 && size <= maxShares * 1.05) {
      price = targetCost / size
    }
    if (entryPriceSuspicious(price)) {
      price = typicalEntryPrice(strategy, cfgMaxAsk)
    }
  }

  size = targetCost / price
  cost = targetCost
  return { entryPrice: price, size, cost }
}

export function settlementPayout(
  row: { side: 'up' | 'down'; size: number; cost: number; entryPrice: number },
  outcome: 'up' | 'down',
): { payout: number; pnl: number } {
  const won = row.side === outcome
  const shares = tradeShares(row)
  const payout = won ? shares : 0
  return { payout, pnl: payout - row.cost }
}
