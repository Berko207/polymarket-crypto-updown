import type { VercelRequest, VercelResponse } from '@vercel/node'
import { warmOrderPath } from './_lib/clob.js'
import { guardTradingApi } from './_lib/auth.js'
import { requireConfigured } from './_lib/guards.js'

function parseTokenIds(req: VercelRequest): string[] {
  const fromQuery = req.query.tokenIds
  const queryValue = Array.isArray(fromQuery) ? fromQuery.join(',') : typeof fromQuery === 'string' ? fromQuery : ''

  if (queryValue.trim()) {
    return queryValue
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  }

  const body = req.body
  if (body == null || body === '') return []
  const parsed =
    typeof body === 'string'
      ? (() => {
          try {
            return JSON.parse(body) as Record<string, unknown>
          } catch {
            return {}
          }
        })()
      : (body as Record<string, unknown>)

  const raw = parsed.tokenIds
  if (Array.isArray(raw)) {
    return raw.map((id) => String(id).trim()).filter(Boolean)
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  }
  return []
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!guardTradingApi(req, res)) return
  if (!requireConfigured(res)) return

  try {
    const tokenIds = parseTokenIds(req)
    if (tokenIds.length) await warmOrderPath(tokenIds)
    return res.status(204).end()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Warm failed'
    return res.status(500).json({ error: message })
  }
}
