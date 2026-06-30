import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authorizeApiRequest, rateLimit } from './_lib/auth.js'
import { isPolyConfigured } from './_lib/env.js'
import { fetchMarketHoldings, fetchPositions } from './_lib/positions.js'

function parseTokenIds(req: VercelRequest): string[] | undefined {
  const raw = req.query.tokenIds
  const value = Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : ''
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  return ids.length ? ids : undefined
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!authorizeApiRequest(req, res)) return
  if (!rateLimit(req, res, { limit: 60, key: 'positions' })) return

  if (!isPolyConfigured()) {
    return res.status(503).json({ error: 'Polymarket credentials are not configured on the server' })
  }

  try {
    const upToken = typeof req.query.upToken === 'string' ? req.query.upToken.trim() : ''
    const downToken = typeof req.query.downToken === 'string' ? req.query.downToken.trim() : ''

    if (upToken || downToken) {
      const positions = await fetchMarketHoldings(upToken || null, downToken || null)
      return res.status(200).json({ positions })
    }

    const positions = await fetchPositions(parseTokenIds(req))
    return res.status(200).json({ positions })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load positions'
    return res.status(500).json({ error: message })
  }
}
