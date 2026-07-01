import { AssetType } from '@polymarket/clob-client-v2'
import { getPolyConfig } from './env.js'
import { getClobClient } from './clob.js'

const DATA_API = 'https://data-api.polymarket.com/positions'

// The Data API sorts by size descending and caps a page, so a heavy account's small
// recent up/down positions live on later pages. Page through them all instead of
// silently truncating at the first page (which hid ~1/3 of this app's positions).
const PAGE_LIMIT = 500
const MAX_PAGES = 8

export interface PositionView {
  tokenId: string
  outcome: string
  size: number
  avgPrice: number
  currentPrice: number
  initialValue: number
  currentValue: number
  cashPnl: number
  percentPnl: number
  title: string
  eventSlug: string
  redeemable: boolean
}

interface DataApiPosition {
  asset?: string
  outcome?: string
  size?: number
  avgPrice?: number
  curPrice?: number
  initialValue?: number
  currentValue?: number
  cashPnl?: number
  percentPnl?: number
  title?: string
  eventSlug?: string
  redeemable?: boolean
}

function normalize(row: DataApiPosition): PositionView | null {
  const tokenId = typeof row.asset === 'string' ? row.asset : null
  if (!tokenId) return null

  const size = Number(row.size)
  if (!Number.isFinite(size) || size <= 0) return null

  const initialValue = Number(row.initialValue) || 0
  let avgPrice = Number(row.avgPrice) || 0
  if (avgPrice <= 0 && initialValue > 0) avgPrice = initialValue / size

  return {
    tokenId,
    outcome: typeof row.outcome === 'string' ? row.outcome : '—',
    size,
    avgPrice,
    currentPrice: Number(row.curPrice) || 0,
    initialValue,
    currentValue: Number(row.currentValue) || 0,
    cashPnl: Number(row.cashPnl) || 0,
    percentPnl: Number(row.percentPnl) || 0,
    title: typeof row.title === 'string' ? row.title : 'Position',
    eventSlug: typeof row.eventSlug === 'string' ? row.eventSlug : '',
    redeemable: row.redeemable === true,
  }
}

export async function fetchTokenBalance(tokenId: string): Promise<number> {
  const client = getClobClient()
  if (!client) return 0

  const res = await client.getBalanceAllowance({
    asset_type: AssetType.CONDITIONAL,
    token_id: tokenId,
  })
  return Number(res.balance) / 1e6
}

async function fetchDataApiPage(user: string, offset: number): Promise<DataApiPosition[]> {
  const url = `${DATA_API}?user=${encodeURIComponent(user)}&sizeThreshold=0.01&limit=${PAGE_LIMIT}&offset=${offset}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Could not load positions (${res.status})`)
  }
  const rows = (await res.json()) as unknown
  return Array.isArray(rows) ? (rows as DataApiPosition[]) : []
}

// One shared account scan per short window: the per-market instant-holdings pollers
// (~1.5s cadence, one per watchlist market) and the global positions poll all funnel
// through fetchPositions, and a scan can span several sequential Data-API pages.
// Reuse the in-flight/recent scan instead of re-walking per request. Raw rows are
// cached (not normalized objects) because fetchMarketHoldings mutates its results.
// Per-instance and best-effort, like the rate limiter.
const SCAN_TTL_MS = 1_500
let scanCache: { user: string; promise: Promise<DataApiPosition[]>; expiresAt: number } | null =
  null

function fetchAccountScan(user: string): Promise<DataApiPosition[]> {
  const now = Date.now()
  if (scanCache && scanCache.user === user && scanCache.expiresAt > now) {
    return scanCache.promise
  }

  const promise = (async () => {
    const raw: DataApiPosition[] = []
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const rows = await fetchDataApiPage(user, page * PAGE_LIMIT)
      raw.push(...rows)
      if (rows.length < PAGE_LIMIT) break
    }
    return raw
  })()

  scanCache = { user, promise, expiresAt: now + SCAN_TTL_MS }
  promise.catch(() => {
    if (scanCache?.promise === promise) scanCache = null
  })
  return promise
}

export async function fetchPositions(tokenIds?: string[]): Promise<PositionView[]> {
  const config = getPolyConfig()
  if (!config) {
    throw new Error('Polymarket credentials are not configured on the server')
  }

  const filter = tokenIds?.filter(Boolean)

  const raw = await fetchAccountScan(config.funderAddress)

  // Offset pages of a size-sorted, live-mutating list can return the same position
  // on two pages — dedupe by token (last occurrence wins; it's the fresher fetch).
  const byToken = new Map<string, PositionView>()
  for (const row of raw) {
    const p = normalize(row)
    if (p) byToken.set(p.tokenId, p)
  }
  const positions = [...byToken.values()]

  if (!filter?.length) return positions

  const wanted = new Set(filter)
  return positions.filter((p) => wanted.has(p.tokenId))
}

export async function fetchMarketHoldings(
  upTokenId: string | null,
  downTokenId: string | null,
): Promise<PositionView[]> {
  const tokenIds = [upTokenId, downTokenId].filter((id): id is string => Boolean(id))
  if (!tokenIds.length) return []

  const [fromApi, ...balances] = await Promise.all([
    fetchPositions(tokenIds),
    ...tokenIds.map((id) => fetchTokenBalance(id)),
  ])

  const byToken = new Map(fromApi.map((p) => [p.tokenId, p]))

  tokenIds.forEach((tokenId, index) => {
    const balance = balances[index]
    if (balance <= 0) {
      byToken.delete(tokenId)
      return
    }

    const existing = byToken.get(tokenId)
    if (existing) {
      // On-chain balance is authoritative for share count. Per-share avgPrice is unchanged
      // by partial sells — rescale dollar aggregates from it instead of zeroing them.
      if (Math.abs(existing.size - balance) > 1e-6) {
        const priorSize = existing.size
        existing.size = balance
        if (existing.avgPrice > 0) {
          existing.initialValue = balance * existing.avgPrice
        } else if (existing.initialValue > 0 && priorSize > 0) {
          const implied = existing.initialValue / priorSize
          existing.avgPrice = implied
          existing.initialValue = balance * implied
        } else {
          existing.initialValue = 0
        }
        existing.currentValue = 0
        existing.cashPnl = 0
        existing.percentPnl = 0
      }
    } else {
      byToken.set(tokenId, {
        tokenId,
        outcome: tokenId === upTokenId ? 'Up' : 'Down',
        size: balance,
        avgPrice: 0,
        currentPrice: 0,
        initialValue: 0,
        currentValue: 0,
        cashPnl: 0,
        percentPnl: 0,
        title: 'This market',
        eventSlug: '',
        redeemable: false,
      })
    }
  })

  return [...byToken.values()].filter((p) => p.size >= 0.01)
}
