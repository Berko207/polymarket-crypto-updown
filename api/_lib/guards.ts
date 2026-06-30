import type { VercelResponse } from '@vercel/node'
import { canPlaceOrders, getPolyConfig, getWalletSetupIssue, isPolyConfigured } from './env.js'

/** 503 if Polymarket credentials aren't configured. Returns false when it has responded. */
export function requireConfigured(res: VercelResponse): boolean {
  if (!isPolyConfigured()) {
    res.status(503).json({ error: 'Polymarket credentials are not configured on the server' })
    return false
  }
  return true
}

/** 403 if there's no signer key to place/manage orders. */
export function requireCanPlaceOrders(res: VercelResponse, action = 'place orders'): boolean {
  if (!canPlaceOrders()) {
    res.status(403).json({ error: `Add POLY_PRIVATE_KEY on the server to ${action}` })
    return false
  }
  return true
}

/** 400 if env vars don't match Polymarket's wallet model (deposit-wallet flow). */
export function requireWalletReady(res: VercelResponse): boolean {
  const config = getPolyConfig()
  const issue = config ? getWalletSetupIssue(config) : null
  if (issue) {
    res.status(400).json({ error: issue })
    return false
  }
  return true
}
