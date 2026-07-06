/**
 * Pure maker P&L accounting (docs/maker-paper-strategy.md §10). Extracted from the
 * index.ts loop so the fill → flatten → settlement money path is deterministically
 * testable without live gamma markets (acceptance §14.5: flatten legs book the taker
 * fee, unflattened inventory books settlement, and the totals reconcile to the ledger).
 *
 * All three functions mutate the passed inventory/account in place (matching how the
 * loop threads per-window state) and return the leg/summary the caller persists.
 */
import { takerFee } from './fees'
import type { MakerFill } from './makerExecutor'
import type { MakerInventory } from './maker'

/** Running money for one maker window (metadata lives alongside it in the loop). */
export interface MakerAccount {
  /** Gross cash paid across all maker buys. */
  cashSpent: number
  /** Rebate earned across fills. */
  rebate: number
  /** Gross proceeds from the boundary flatten sell(s). */
  flatten: number
  /** Taker fees paid (flatten leg; 0 unless feeSell). */
  fees: number
  /** Total shares bought (both sides) — for the synthesized row's avg price. */
  grossShares: number
}

export function emptyAccount(): MakerAccount {
  return { cashSpent: 0, rebate: 0, flatten: 0, fees: 0, grossShares: 0 }
}

/** Book one simulated fill into inventory + running account. */
export function applyFill(acct: MakerAccount, inv: MakerInventory, fill: MakerFill): void {
  if (fill.side === 'up') inv.upShares += fill.size
  else inv.downShares += fill.size
  acct.cashSpent += fill.price * fill.size
  acct.rebate += fill.rebate
  acct.grossShares += fill.size
}

export interface FlattenLeg {
  side: 'up' | 'down'
  qty: number
  price: number
  fee: number
}

/**
 * Flatten the net position by selling into `bid` (a marketable taker sell — the one
 * place a maker crosses the spread). Fee-exempt today unless feeSell. Mutates inv/acct
 * and returns the leg, or null when there's nothing to flatten or no book to sell into.
 */
export function flatten(
  acct: MakerAccount,
  inv: MakerInventory,
  bid: number | null,
  feeRate: number,
  feeSell: boolean,
): FlattenLeg | null {
  const q = inv.upShares - inv.downShares
  const qty = Math.abs(q)
  if (qty < 1e-6 || bid == null || !(bid > 0)) return null
  const side: 'up' | 'down' = q > 0 ? 'up' : 'down'
  const fee = feeSell ? takerFee(bid, qty, feeRate) : 0
  acct.flatten += bid * qty
  acct.fees += fee
  if (side === 'up') inv.upShares -= qty
  else inv.downShares -= qty
  return { side, qty, price: bid, fee }
}

export interface MakerSettlement {
  side: 'up' | 'down'
  size: number
  entryPrice: number
  cost: number
  payout: number
  pnl: number
}

/**
 * Final P&L for a window. Residual inventory settles $1 on the winning side / $0 on
 * the loser; payout = rebate + flatten proceeds + settlement; pnl = payout − cash − fees.
 */
export function settle(acct: MakerAccount, inv: MakerInventory, outcome: 'up' | 'down' | null): MakerSettlement {
  const settlement = outcome == null ? 0 : outcome === 'up' ? inv.upShares : inv.downShares
  const cost = acct.cashSpent
  const payout = acct.rebate + acct.flatten + settlement
  const pnl = payout - cost - acct.fees
  return {
    side: inv.upShares >= inv.downShares ? 'up' : 'down',
    size: acct.grossShares,
    entryPrice: acct.grossShares > 0 ? acct.cashSpent / acct.grossShares : 0,
    cost,
    payout,
    pnl,
  }
}
