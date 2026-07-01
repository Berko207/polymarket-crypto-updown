import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authorizeApiRequest, rateLimit } from './_lib/auth.js'
import { requireConfigured } from './_lib/guards.js'
import { getPolyConfig } from './_lib/env.js'

const DATA_API = 'https://data-api.polymarket.com/trades'
/** Data API silently clamps limit to 1000. */
const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 40
/** Data API 400s past this: "max historical activity offset of 3000 exceeded". */
const MAX_UPSTREAM_OFFSET = 3000

interface DataApiTrade {
  asset?: string
  conditionId?: string
  side?: string
  size?: number | string
  price?: number | string
  timestamp?: number | string
  title?: string
  slug?: string
  eventSlug?: string
  outcome?: string
  transactionHash?: string
}

export interface TradeFillView {
  /** Stable-enough row key: tx hash + token + side (one tx can carry both legs). */
  id: string
  tokenId: string
  side: 'BUY' | 'SELL'
  outcome: string
  size: number
  price: number
  /** Unix seconds. */
  timestamp: number
  title: string
  eventSlug: string
  transactionHash: string
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function normalize(row: DataApiTrade): TradeFillView | null {
  const tokenId = typeof row.asset === 'string' ? row.asset : ''
  const side = row.side === 'BUY' || row.side === 'SELL' ? row.side : null
  const size = Number(row.size)
  const price = Number(row.price)
  const timestamp = Number(row.timestamp)
  if (!tokenId || !side || !Number.isFinite(size) || !Number.isFinite(price)) return null

  const transactionHash = typeof row.transactionHash === 'string' ? row.transactionHash : ''
  return {
    id: `${transactionHash || timestamp}:${tokenId.slice(0, 16)}:${side}`,
    tokenId,
    side,
    outcome: typeof row.outcome === 'string' ? row.outcome : '',
    size,
    price,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    title: typeof row.title === 'string' ? row.title : '',
    eventSlug: typeof row.eventSlug === 'string' ? row.eventSlug : row.slug ?? '',
    transactionHash,
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!authorizeApiRequest(req, res)) return
  if (!rateLimit(req, res, { limit: 120, key: 'trade-history' })) return
  if (!requireConfigured(res)) return

  const config = getPolyConfig()
  if (!config) return res.status(503).json({ error: 'Polymarket credentials not configured' })

  const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
  const offset = clampInt(req.query.offset, 0, 0, MAX_UPSTREAM_OFFSET)

  try {
    const url = `${DATA_API}?user=${encodeURIComponent(config.funderAddress)}&limit=${limit}&offset=${offset}`
    const upstream = await fetch(url)
    if (!upstream.ok) {
      return res.status(502).json({ error: `Could not load trade history (${upstream.status})` })
    }

    const rows = (await upstream.json()) as unknown
    const trades = (Array.isArray(rows) ? (rows as DataApiTrade[]) : [])
      .map(normalize)
      .filter((t): t is TradeFillView => t != null)

    // Account data — keep it out of shared edge caches.
    res.setHeader('Cache-Control', 'no-store')
    const fullPage = trades.length === limit
    const nextPageReachable = offset + limit <= MAX_UPSTREAM_OFFSET
    return res.status(200).json({
      trades,
      // Data API pages by offset; a full page means there may be more — but never
      // hand out an offset the upstream would 400 on.
      nextOffset: fullPage && nextPageReachable ? offset + limit : null,
      // Older fills exist upstream but sit beyond the Data API's offset cap.
      capReached: fullPage && !nextPageReachable,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load trade history'
    return res.status(500).json({ error: message })
  }
}
