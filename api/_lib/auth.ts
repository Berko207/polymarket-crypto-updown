import type { VercelRequest, VercelResponse } from '@vercel/node'

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

export function getApiSecret(): string | undefined {
  return readEnv('APP_API_SECRET')
}

export function isTradingEnabled(): boolean {
  const flag = readEnv('POLY_TRADING_ENABLED')
  return flag !== '0' && flag !== 'false'
}

export function getMaxOrderSize(): number {
  const value = Number(readEnv('POLY_MAX_ORDER_SIZE') ?? '1000')
  return Number.isFinite(value) && value > 0 ? value : 1000
}

export function getMaxOrderCost(): number {
  const value = Number(readEnv('POLY_MAX_ORDER_COST') ?? '500')
  return Number.isFinite(value) && value > 0 ? value : 500
}

function extractToken(req: VercelRequest): string | undefined {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
  const header = req.headers['x-api-key']
  if (typeof header === 'string') return header.trim()
  return undefined
}

export function authorizeApiRequest(req: VercelRequest, res: VercelResponse): boolean {
  const secret = getApiSecret()
  if (!secret) return true

  const provided = extractToken(req)
  if (!provided || provided !== secret) {
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }
  return true
}

const buckets = new Map<string, { count: number; resetAt: number }>()

export function rateLimit(
  req: VercelRequest,
  res: VercelResponse,
  { limit = 60, windowMs = 60_000, key = 'default' }: { limit?: number; windowMs?: number; key?: string } = {},
): boolean {
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? 'unknown'
  const bucketKey = `${ip}:${key}`
  const now = Date.now()
  let bucket = buckets.get(bucketKey)

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs }
    buckets.set(bucketKey, bucket)
  }

  bucket.count += 1
  if (bucket.count > limit) {
    res.status(429).json({ error: 'Too many requests — try again shortly' })
    return false
  }
  return true
}

export function guardTradingApi(req: VercelRequest, res: VercelResponse): boolean {
  if (!authorizeApiRequest(req, res)) return false
  if (!rateLimit(req, res, { limit: 120, key: 'trading' })) return false
  if (!isTradingEnabled()) {
    res.status(503).json({ error: 'Trading is disabled (POLY_TRADING_ENABLED=false)' })
    return false
  }
  return true
}
