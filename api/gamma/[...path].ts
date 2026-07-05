import type { VercelRequest, VercelResponse } from '@vercel/node'

const GAMMA_ORIGIN = 'https://gamma-api.polymarket.com'
const ROUTE_PREFIX = '/api/gamma/'

/** Upstream gamma endpoints the dashboard is allowed to proxy (first path segment). */
const ALLOWED_SEGMENTS = new Set(['events', 'markets', 'series', 'public-profile', 'tags'])

function isSafePath(segments: string): boolean {
  if (!segments) return false
  if (segments.includes('://') || segments.includes('..') || segments.startsWith('/')) return false
  const first = segments.split('/')[0]?.split('?')[0] ?? ''
  return ALLOWED_SEGMENTS.has(first)
}

function gammaPath(req: VercelRequest): string {
  const fromUrl = (() => {
    if (!req.url) return ''
    const pathname = new URL(req.url, 'http://localhost').pathname
    return pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) : ''
  })()

  if (fromUrl) return fromUrl

  const path = req.query.path
  if (Array.isArray(path)) return path.join('/')
  return typeof path === 'string' ? path : ''
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const segments = gammaPath(req)
  if (!isSafePath(segments)) {
    return res.status(404).json({ error: 'Unknown gamma endpoint' })
  }

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'path' || value == null) continue
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item))
    } else {
      params.append(key, String(value))
    }
  }

  const qs = params.toString()
  const upstreamUrl = `${GAMMA_ORIGIN}/${segments}${qs ? `?${qs}` : ''}`

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: req.method })
  } catch {
    return res.status(502).json({ error: 'Upstream gamma request failed' })
  }
  const body = req.method === 'HEAD' ? null : await upstream.text()

  // Live prices ride the WS overlay and in-window/live state is recomputed
  // client-side from the wall clock, so the gamma snapshot is mostly stable
  // per-round metadata — a 10s edge TTL dedupes polling without staling the UI.
  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30')
  const contentType = upstream.headers.get('content-type')
  if (contentType) res.setHeader('Content-Type', contentType)

  return res.status(upstream.status).send(body)
}
