/**
 * Polymarket Data-API positions — live in-window marks and redeemable flag only.
 * Resolved win/loss for the bot monitor comes from the oracle outcomes table.
 */
export const DATA_API = 'https://data-api.polymarket.com/positions'

export interface PolyPositionSnap {
  avgPrice: number
  curPrice: number
  cashPnl: number
  currentValue: number
  initialValue: number
  redeemable: boolean
}

interface DataApiRow {
  asset?: string
  avgPrice?: number
  curPrice?: number
  cashPnl?: number
  currentValue?: number
  initialValue?: number
  redeemable?: boolean
  size?: number
}

/** All positions for the funder wallet, keyed by token id. */
export async function fetchPolyPositionsByToken(user: string): Promise<Map<string, PolyPositionSnap>> {
  const out = new Map<string, PolyPositionSnap>()
  const limit = 500
  for (let page = 0; page < 8; page++) {
    const url = `${DATA_API}?user=${encodeURIComponent(user)}&sizeThreshold=0.01&limit=${limit}&offset=${page * limit}`
    const res = await fetch(url)
    if (!res.ok) break
    const rows = (await res.json()) as DataApiRow[]
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const row of rows) {
      const tokenId = typeof row.asset === 'string' ? row.asset : null
      const size = Number(row.size)
      if (!tokenId || !(size > 0)) continue
      const initialValue = Number(row.initialValue) || 0
      let avgPrice = Number(row.avgPrice) || 0
      if (avgPrice <= 0 && initialValue > 0) avgPrice = initialValue / size
      out.set(tokenId, {
        avgPrice,
        curPrice: Number(row.curPrice) || 0,
        cashPnl: Number(row.cashPnl) || 0,
        currentValue: Number(row.currentValue) || 0,
        initialValue,
        redeemable: row.redeemable === true,
      })
    }
    if (rows.length < limit) break
  }
  return out
}
