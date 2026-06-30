/**
 * Single multiplexed connection to the Polymarket CLOB market WebSocket.
 *
 * Replaces the two near-identical subscribe functions in the old `clobWs.ts`:
 * every consumer (watchlist, focused market, portfolio) subscribes a set of
 * outcome tokens here and shares ONE socket. The union of all subscribed tokens
 * drives a single `assets_ids` subscription; consumers each receive a snapshot
 * scoped to the tokens they asked for.
 */

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const PING_MS = 10_000
const RECONNECT_MS = 2_000
const RECONCILE_DEBOUNCE_MS = 30

export interface TokenQuote {
  bestBid: number | null
  bestAsk: number | null
  lastTrade: number | null
}

export type TokenQuoteMap = Record<string, TokenQuote>

function emptyQuote(): TokenQuote {
  return { bestBid: null, bestAsk: null, lastTrade: null }
}

function toNum(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Midpoint of bid/ask, falling back to last trade — matches Polymarket order book display. */
export function quoteToPrice(quote: TokenQuote | undefined): number | null {
  if (!quote) return null
  if (quote.bestBid != null && quote.bestAsk != null) {
    return (quote.bestBid + quote.bestAsk) / 2
  }
  if (quote.lastTrade != null) return quote.lastTrade
  if (quote.bestAsk != null) return quote.bestAsk
  if (quote.bestBid != null) return quote.bestBid
  return null
}

export function bestBidFromQuotes(quotes: TokenQuoteMap, tokenId: string | null | undefined): number | null {
  if (!tokenId) return null
  return quotes[tokenId]?.bestBid ?? null
}

export function midFromQuotes(quotes: TokenQuoteMap, tokenId: string | null | undefined): number | null {
  if (!tokenId) return null
  return quoteToPrice(quotes[tokenId])
}

function bestFromBook(bids: Array<{ price: string }>, asks: Array<{ price: string }>) {
  let bestBid: number | null = null
  let bestAsk: number | null = null
  for (const level of bids) {
    const p = toNum(level.price)
    if (p != null && (bestBid == null || p > bestBid)) bestBid = p
  }
  for (const level of asks) {
    const p = toNum(level.price)
    if (p != null && (bestAsk == null || p < bestAsk)) bestAsk = p
  }
  return { bestBid, bestAsk }
}

function patchQuote(map: TokenQuoteMap, assetId: string, patch: Partial<TokenQuote>) {
  map[assetId] = { ...(map[assetId] ?? emptyQuote()), ...patch }
}

/** Apply one (or an array of) raw CLOB frame(s) to the shared quote map. Returns true if anything changed. */
function applyFrame(raw: unknown, map: TokenQuoteMap): boolean {
  if (Array.isArray(raw)) {
    let changed = false
    for (const item of raw) changed = applyFrame(item, map) || changed
    return changed
  }
  if (!raw || typeof raw !== 'object') return false

  const msg = raw as Record<string, unknown>
  switch (msg.event_type as string | undefined) {
    case 'book': {
      const assetId = msg.asset_id as string | undefined
      if (!assetId) return false
      const { bestBid, bestAsk } = bestFromBook(
        (msg.bids as Array<{ price: string }>) ?? [],
        (msg.asks as Array<{ price: string }>) ?? [],
      )
      patchQuote(map, assetId, { bestBid, bestAsk })
      return true
    }
    case 'price_change': {
      const items = (msg.price_changes as Array<{ asset_id: string; best_bid?: string; best_ask?: string }>) ?? []
      for (const item of items) {
        patchQuote(map, item.asset_id, { bestBid: toNum(item.best_bid), bestAsk: toNum(item.best_ask) })
      }
      return items.length > 0
    }
    case 'best_bid_ask': {
      const assetId = msg.asset_id as string | undefined
      if (!assetId) return false
      patchQuote(map, assetId, { bestBid: toNum(msg.best_bid), bestAsk: toNum(msg.best_ask) })
      return true
    }
    case 'last_trade_price': {
      const assetId = msg.asset_id as string | undefined
      if (!assetId) return false
      patchQuote(map, assetId, { lastTrade: toNum(msg.price) })
      return true
    }
    default:
      return false
  }
}

interface Subscription {
  tokenIds: Set<string>
  onUpdate: (quotes: TokenQuoteMap) => void
  onConnectedChange?: (connected: boolean) => void
}

class ClobSocket {
  private subs = new Set<Subscription>()
  private quotes: TokenQuoteMap = {}
  private ws: WebSocket | null = null
  private subscribedIds: string[] = []
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null
  private connected = false

  subscribe(
    tokenIds: string[],
    onUpdate: (quotes: TokenQuoteMap) => void,
    onConnectedChange?: (connected: boolean) => void,
  ): () => void {
    const sub: Subscription = {
      tokenIds: new Set(tokenIds.filter(Boolean)),
      onUpdate,
      onConnectedChange,
    }
    this.subs.add(sub)
    onUpdate(this.snapshot(sub.tokenIds))
    onConnectedChange?.(this.connected)
    this.scheduleReconcile()
    return () => {
      this.subs.delete(sub)
      this.scheduleReconcile()
    }
  }

  private snapshot(ids: Set<string>): TokenQuoteMap {
    const out: TokenQuoteMap = {}
    for (const id of ids) out[id] = this.quotes[id] ?? emptyQuote()
    return out
  }

  private union(): string[] {
    const set = new Set<string>()
    for (const sub of this.subs) for (const id of sub.tokenIds) set.add(id)
    return [...set].sort()
  }

  private scheduleReconcile() {
    if (this.reconcileTimer) return
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null
      this.reconcile()
    }, RECONCILE_DEBOUNCE_MS)
  }

  private reconcile() {
    const next = this.union()
    if (next.length === 0) {
      this.teardown()
      return
    }
    const same = next.length === this.subscribedIds.length && next.every((id, i) => id === this.subscribedIds[i])
    if (same && this.ws && this.ws.readyState !== WebSocket.CLOSED) return
    this.openSocket(next)
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.pingTimer = null
    this.reconnectTimer = null
  }

  private detach(ws: WebSocket) {
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
  }

  private setConnected(connected: boolean) {
    if (this.connected === connected) return
    this.connected = connected
    for (const sub of this.subs) sub.onConnectedChange?.(connected)
  }

  private notifyQuotes() {
    for (const sub of this.subs) sub.onUpdate(this.snapshot(sub.tokenIds))
  }

  private openSocket(ids: string[]) {
    this.clearTimers()
    if (this.ws) {
      const old = this.ws
      this.detach(old)
      try {
        old.close()
      } catch {
        // ignore
      }
      this.ws = null
    }

    this.subscribedIds = ids
    const ws = new WebSocket(WS_URL)
    this.ws = ws

    ws.onopen = () => {
      if (ws !== this.ws) return
      this.setConnected(true)
      ws.send(JSON.stringify({ assets_ids: ids, type: 'market', custom_feature_enabled: true }))
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING')
      }, PING_MS)
    }

    ws.onmessage = (event) => {
      if (ws !== this.ws) return
      if (event.data === 'PONG') return
      try {
        if (applyFrame(JSON.parse(event.data as string), this.quotes)) this.notifyQuotes()
      } catch {
        // ignore malformed frames
      }
    }

    ws.onclose = () => {
      if (ws !== this.ws) return
      this.setConnected(false)
      this.clearTimers()
      this.ws = null
      if (this.subs.size > 0) {
        this.reconnectTimer = setTimeout(() => this.openSocket(this.union()), RECONNECT_MS)
      }
    }

    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
  }

  private teardown() {
    this.clearTimers()
    if (this.ws) {
      this.detach(this.ws)
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    this.subscribedIds = []
    this.setConnected(false)
  }
}

export const clobSocket = new ClobSocket()
