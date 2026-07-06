/**
 * Maker-side accounting for the maker paper-strategy (docs/maker-paper-strategy.md).
 * A maker pays NO taker fee (fees.ts: makers are exempt) and MAY earn a USDC
 * rebate. Whether crypto up/down actually pays a rebate today is open Q1 in the
 * spec — `fees.ts` says "makers paid zero" — so `rebateRate` defaults to 0 and the
 * strategy must show an edge from spread capture + fee-avoidance ALONE; the rebate
 * is modeled as upside to confirm against Polymarket's live program, not the thesis.
 *
 * Modeled as a flat rebate per filled share (rate·shares). If the real program is
 * notional- or band-scaled, swap the formula here — everything downstream reads
 * this one function.
 */
export function makerRebate(price: number, shares: number, rebateRate: number): number {
  if (!(price > 0 && price < 1) || !(shares > 0) || !(rebateRate > 0)) return 0
  return rebateRate * shares
}
