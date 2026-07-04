/**
 * Live-order guards — same env knobs the API enforces (api/_lib/auth.ts),
 * replicated here so the bot doesn't pull in Vercel request types. The per-order
 * balance check is left to the CLOB (it rejects underfunded orders); startup
 * verifies wallet-ready + a positive balance via fetchAccountSnapshot.
 */
export function maxOrderCost(): number {
  const v = Number(process.env.POLY_MAX_ORDER_COST ?? '500')
  return Number.isFinite(v) && v > 0 ? v : 500
}

export function tradingEnabled(): boolean {
  const flag = process.env.POLY_TRADING_ENABLED?.trim()
  return flag !== '0' && flag !== 'false'
}
