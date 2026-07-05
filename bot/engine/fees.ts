/**
 * Taker-fee model for paper accounting. Polymarket's 2026 CLOB-v2 fee is a
 * parabola that peaks at 50¢ and vanishes at the extremes — built to tax exactly
 * the ~50/50 zone where crypto up/down markets live and to kill latency scalping.
 * With crypto feeRate ≈ 0.07 (CLOB-v2 schedule / NautilusTrader adapter):
 *
 *   fee_collateral = feeRate · p · (1 − p) · shares
 *
 * That is ≈ 1.75% per share of max payout at p=0.5 (feeRate·p·(1−p)) — the widely
 * quoted "≈1.8% at 50¢" — or, as a fraction of the BUY notional (shares·p), it is
 * feeRate·(1−p) ≈ 3.5% at p=0.5, tapering to ≈ 0 near 1¢/99¢. Either way it peaks
 * in the middle. Polymarket currently EXEMPTS sells and pays makers
 * zero, so by default we charge the fee on the taker BUY leg only; BOT_FEE_SELL=1
 * also charges the exit as a conservative upper bound. These are MODELED costs for
 * paper realism (the live executor records the real fills). BOT_FEE_RATE=0 disables
 * the model entirely. Without this, a round-trip scalp looks profitable on paper
 * while it bleeds fees + spread live.
 */
export function takerFee(price: number, shares: number, feeRate: number): number {
  if (!(price > 0 && price < 1) || !(shares > 0) || !(feeRate > 0)) return 0
  return feeRate * price * (1 - price) * shares
}
