import type { VercelRequest, VercelResponse } from '@vercel/node'

const GAMMA_ORIGIN = 'https://gamma-api.polymarket.com'
const ROUTE_PREFIX = '/api/gamma/'

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

  const upstream = await fetch(upstreamUrl, { method: req.method })
  const body = req.method === 'HEAD' ? null : await upstream.text()

  res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=30')
  const contentType = upstream.headers.get('content-type')
  if (contentType) res.setHeader('Content-Type', contentType)

  return res.status(upstream.status).send(body)
}
