import type { VercelRequest, VercelResponse } from '@vercel/node'
import { fetchAccountSnapshot } from './_lib/clob.js'
import { authorizeApiRequest, rateLimit } from './_lib/auth.js'
import { canPlaceOrders, getPolyConfig, getWalletSetupIssue, isPolyConfigured } from './_lib/env.js'
import { resolveTradingWallet } from './_lib/wallet.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!authorizeApiRequest(req, res)) return
  if (!rateLimit(req, res, { limit: 60, key: 'account' })) return

  if (!isPolyConfigured()) {
    return res.status(200).json({
      configured: false,
      canTrade: false,
      message:
        'Set POLY_* environment variables in Vercel (production) or .env.local (local dev). Keys never belong in the browser.',
    })
  }

  const config = getPolyConfig()!
  const walletSetupIssue = getWalletSetupIssue(config)
  const resolved = await resolveTradingWallet(config.address)
  const suggestedFunderAddress = resolved.proxyWallet
  const funderMismatch =
    suggestedFunderAddress != null &&
    suggestedFunderAddress.toLowerCase() !== config.funderAddress.toLowerCase()

  try {
    const account = await fetchAccountSnapshot()
    return res.status(200).json({
      configured: true,
      ...account,
      suggestedFunderAddress,
      funderMismatch,
      canTrade: account.canTrade && !funderMismatch,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not verify credentials'
    return res.status(200).json({
      configured: true,
      address: config.address,
      funderAddress: config.funderAddress,
      signatureType: config.signatureType,
      suggestedFunderAddress,
      funderMismatch,
      canTrade: canPlaceOrders() && !walletSetupIssue && !funderMismatch,
      walletSetupIssue,
      error: message,
    })
  }
}
