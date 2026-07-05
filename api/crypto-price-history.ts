import type { VercelRequest, VercelResponse } from '@vercel/node'

const UPSTREAM = 'https://polymarket.com/api/crypto/price-history'
const ALLOWED_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB'])
const ALLOWED_VARIANTS = new Set(['daily', 'hourly'])

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const symbol = String(req.query.symbol ?? '')
    .trim()
    .toUpperCase()
  const eventStartTime = String(req.query.eventStartTime ?? '').trim()
  const variant = String(req.query.variant ?? '').trim()

  if (!symbol || !ALLOWED_SYMBOLS.has(symbol)) {
    return res.status(400).json({ error: 'symbol must be one of BTC, ETH, SOL, XRP, DOGE, BNB' })
  }
  if (!eventStartTime) {
    return res.status(400).json({ error: 'eventStartTime is required (ISO or unix seconds)' })
  }
  if (variant && !ALLOWED_VARIANTS.has(variant)) {
    return res.status(400).json({ error: 'variant must be daily or hourly' })
  }

  const params = new URLSearchParams({ symbol, eventStartTime })
  if (variant) params.set('variant', variant)

  try {
    const upstream = await fetch(`${UPSTREAM}?${params}`)
    const body = await upstream.text()
    const contentType = upstream.headers.get('content-type')
    if (contentType) res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60')
    return res.status(upstream.status).send(body)
  } catch {
    return res.status(502).json({ error: 'Upstream price history request failed' })
  }
}
