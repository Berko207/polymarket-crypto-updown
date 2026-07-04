import type { VercelRequest, VercelResponse } from '@vercel/node'

const UPSTREAM = 'https://polymarket.com/api/crypto/crypto-price'
const ALLOWED_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB'])
// Upstream window discriminators (names taken from polymarket.com's own event pages).
// Without the right variant the API ignores endDate and anchors openPrice to the hour.
const ALLOWED_VARIANTS = new Set(['fiveminute', 'fifteen', 'fourhour', 'daily'])

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const symbol = String(req.query.symbol ?? '')
    .trim()
    .toUpperCase()
  const eventStartTime = String(req.query.eventStartTime ?? '').trim()
  const endDate = String(req.query.endDate ?? '').trim()
  const variant = String(req.query.variant ?? '')
    .trim()
    .toLowerCase()

  if (!symbol || !ALLOWED_SYMBOLS.has(symbol)) {
    return res.status(400).json({ error: 'symbol must be one of BTC, ETH, SOL, XRP, DOGE, BNB' })
  }
  if (!eventStartTime) {
    return res.status(400).json({ error: 'eventStartTime is required (ISO or unix seconds)' })
  }
  if (variant && !ALLOWED_VARIANTS.has(variant)) {
    return res.status(400).json({ error: 'variant must be one of fiveminute, fifteen, fourhour, daily' })
  }

  const params = new URLSearchParams({ symbol, eventStartTime })
  if (endDate) params.set('endDate', endDate)
  if (variant) params.set('variant', variant)

  try {
    const upstream = await fetch(`${UPSTREAM}?${params}`)
    const body = await upstream.text()
    const contentType = upstream.headers.get('content-type')
    if (contentType) res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(upstream.status).send(body)
  } catch {
    return res.status(502).json({ error: 'Upstream crypto price request failed' })
  }
}
