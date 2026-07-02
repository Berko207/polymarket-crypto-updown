import type { Position } from './api'
import type { TimeframeId } from './types'

const FILL_TTL_MS = 5 * 60_000
// Sold-hides must outlive Data-API indexing lag (stale rows would resurrect the sold
// position) but not the whole session — a token re-bought outside the app was
// invisible until page reload when this was a plain Set.
const SOLD_TTL_MS = 5 * 60_000
const MIN_SIZE = 0.01

export interface RecentFillMeta {
  outcome: string
  eventSlug: string
  title: string
  timeframe: TimeframeId
  upTokenId: string | null
  downTokenId: string | null
}

interface RecentFillEntry {
  price: number
  size?: number
  at: number
  meta?: RecentFillMeta
}

const fills = new Map<string, RecentFillEntry>()
const soldTokens = new Map<string, number>()
let version = 0
const listeners = new Set<() => void>()

// Both maps survive a reload/HMR via localStorage: they bridge Data-API indexing lag
// (~1 min), so losing them mid-lag made a just-sold row reappear on the next portfolio
// load — and a just-bought one vanish — until the API caught up.
const STORAGE_KEY = 'crypto-updown.recent-fills.v1'

interface PersistedFills {
  fills?: [string, RecentFillEntry][]
  sold?: [string, number][]
}

function hydrate(): void {
  if (typeof localStorage === 'undefined') return
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const data = JSON.parse(raw) as PersistedFills
    const now = Date.now()
    for (const [tokenId, entry] of data.fills ?? []) {
      if (
        tokenId &&
        entry &&
        typeof entry.at === 'number' &&
        typeof entry.price === 'number' &&
        now - entry.at <= FILL_TTL_MS
      ) {
        fills.set(tokenId, entry)
      }
    }
    for (const [tokenId, at] of data.sold ?? []) {
      if (tokenId && typeof at === 'number' && now - at <= SOLD_TTL_MS) {
        soldTokens.set(tokenId, at)
      }
    }
  } catch {
    // Corrupt or blocked storage — start clean; overlays degrade to in-memory only.
  }
}

function persist(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fills: [...fills], sold: [...soldTokens] }))
  } catch {
    // Quota/blocked — in-memory overlay still works for this session.
  }
}

hydrate()

function bump(): void {
  version += 1
  persist()
  listeners.forEach((l) => l())
}

export function subscribeRecentFills(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => listeners.delete(onStoreChange)
}

export function getRecentFillsVersion(): number {
  return version
}

function prune(tokenId: string): RecentFillEntry | undefined {
  const entry = fills.get(tokenId)
  if (!entry) return undefined
  if (Date.now() - entry.at > FILL_TTL_MS) {
    fills.delete(tokenId)
    return undefined
  }
  return entry
}

/** Remember a just-filled buy until chain + Data API catch up. */
export function rememberRecentFill(
  tokenId: string,
  price: number,
  size?: number,
  meta?: RecentFillMeta,
) {
  if (!tokenId || !(price > 0 && price < 1)) return
  soldTokens.delete(tokenId)
  fills.set(tokenId, { price, size, at: Date.now(), meta })
  bump()
}

export function rememberRecentSell(tokenId: string): void {
  if (!tokenId) return
  fills.delete(tokenId)
  soldTokens.set(tokenId, Date.now())
  bump()
}

export function isRecentlySold(tokenId: string): boolean {
  const at = soldTokens.get(tokenId)
  if (at == null) return false
  if (Date.now() - at > SOLD_TTL_MS) {
    // Lazy expiry, no bump — callers run per render, so the change is already visible.
    soldTokens.delete(tokenId)
    return false
  }
  return true
}

export function hasRecentFill(tokenId: string): boolean {
  return prune(tokenId) != null
}

export function clearRecentFill(tokenId: string): void {
  if (!fills.delete(tokenId)) return
  bump()
}

export function clearRecentSell(tokenId: string): void {
  if (!soldTokens.delete(tokenId)) return
  bump()
}

export function recentFillPrice(tokenId: string): number | undefined {
  return prune(tokenId)?.price
}

export function recentFillSize(tokenId: string): number | undefined {
  return prune(tokenId)?.size
}

/** Synthetic positions from in-flight buys — shown before chain balance updates. */
export function recentFillPositions(): Position[] {
  const rows: Position[] = []
  for (const [tokenId, entry] of fills) {
    if (isRecentlySold(tokenId)) continue
    if (Date.now() - entry.at > FILL_TTL_MS) {
      fills.delete(tokenId)
      continue
    }
    const size = entry.size
    if (size == null || size < MIN_SIZE || !entry.meta) continue
    rows.push({
      tokenId,
      outcome: entry.meta.outcome,
      size,
      avgPrice: entry.price,
      currentPrice: entry.price,
      initialValue: size * entry.price,
      title: entry.meta.title,
      eventSlug: entry.meta.eventSlug,
      redeemable: false,
    })
  }
  return rows
}
