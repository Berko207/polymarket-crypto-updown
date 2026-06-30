import { AssetType } from '@polymarket/clob-client-v2'
import { getPolyConfig } from './env.js'
import { getClobClient } from './clob.js'

const DATA_API = 'https://data-api.polymarket.com/positions'

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

  return {
    tokenId,
    outcome: typeof row.outcome === 'string' ? row.outcome : '—',
    size,
    avgPrice: Number(row.avgPrice) || 0,
    currentPrice: Number(row.curPrice) || 0,
    initialValue: Number(row.initialValue) || 0,
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

export async function fetchPositions(tokenIds?: string[]): Promise<PositionView[]> {
  const config = getPolyConfig()
  if (!config) {
    throw new Error('Polymarket credentials are not configured on the server')
  }

  const filter = tokenIds?.filter(Boolean)
  const url = `${DATA_API}?user=${encodeURIComponent(config.funderAddress)}&sizeThreshold=0.01&limit=200`

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Could not load positions (${res.status})`)
  }

  const rows = (await res.json()) as DataApiPosition[]
  if (!Array.isArray(rows)) return []

  const positions = rows.map(normalize).filter((p): p is PositionView => p != null)

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
      existing.size = Math.max(existing.size, balance)
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

  return [...byToken.values()].filter((p) => p.size > 0)
}
