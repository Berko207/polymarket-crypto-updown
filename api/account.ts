import type { VercelRequest, VercelResponse } from '@vercel/node'
import { fetchAccountSnapshot } from './_lib/clob.js'
import { authorizeApiRequest, rateLimit } from './_lib/auth.js'
import { canPlaceOrders, getPolyConfig, isPolyConfigured } from './_lib/env.js'

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

  try {
    const account = await fetchAccountSnapshot()
    return res.status(200).json({
      configured: true,
      ...account,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not verify credentials'
    return res.status(200).json({
      configured: true,
      address: config.address,
      funderAddress: config.funderAddress,
      canTrade: canPlaceOrders(),
      error: message,
    })
  }
}
