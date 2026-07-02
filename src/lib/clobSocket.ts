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
/** Give a replacement socket this long to reach OPEN before abandoning the attempt —
 * a blackholed handshake (sleep/wake, VPN flip) must not gate reconcile forever. */
const CONNECT_TIMEOUT_MS = 10_000
/** No frame (book/quote OR PONG) for this long on the active OPEN socket → force-reconnect
 * a half-open/silent connection the browser never reported as closed. PONG (every PING_MS)
 * keeps a quiet-but-healthy market fresh, so this only trips on a genuinely dead socket. */
const STALE_SOCKET_MS = 30_000
/** Watchdog cadence — well under STALE_SOCKET_MS so a stall is caught within ~one interval. */
const WATCHDOG_MS = 5_000

/** One resting order-book price level. */
export interface BookLevel {
  price: number
  size: number
}

export interface TokenQuote {
  bestBid: number | null
  bestAsk: number | null
  lastTrade: number | null
  /** Bid ladder, best (highest) price first. Populated only from the WebSocket book. */
  bids: BookLevel[]
  /** Ask ladder, best (lowest) price first. Populated only from the WebSocket book. */
  asks: BookLevel[]
}

export type TokenQuoteMap = Record<string, TokenQuote>

function emptyQuote(): TokenQuote {
  return { bestBid: null, bestAsk: null, lastTrade: null, bids: [], asks: [] }
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

/** True when the socket has real book data for this token (not just an empty snapshot slot). */
export function quoteHasBook(quote: TokenQuote | undefined): boolean {
  if (!quote) return false
  return quote.bestBid != null || quote.bestAsk != null || quote.lastTrade != null
}

export function bestBidFromQuotes(quotes: TokenQuoteMap, tokenId: string | null | undefined): number | null {
  if (!tokenId) return null
  return quotes[tokenId]?.bestBid ?? null
}

export function midFromQuotes(quotes: TokenQuoteMap, tokenId: string | null | undefined): number | null {
  if (!tokenId) return null
  return quoteToPrice(quotes[tokenId])
}

/** Parse a raw book side into a sorted {@link BookLevel} ladder (best price first). */
function ladderFromRaw(raw: Array<{ price?: string; size?: string }>, side: 'bid' | 'ask'): BookLevel[] {
  const out: BookLevel[] = []
  for (const level of raw) {
    const price = toNum(level.price)
    const size = toNum(level.size)
    if (price != null && size != null && size > 0) out.push({ price, size })
  }
  // Bids: highest price first. Asks: lowest price first.
  out.sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price))
  return out
}

/** Upsert one price level into a ladder, returning a NEW array (size 0 removes the level). */
function upsertLevel(ladder: BookLevel[], side: 'bid' | 'ask', price: number, size: number): BookLevel[] {
  const next = ladder.filter((l) => l.price !== price)
  if (size > 0) next.push({ price, size })
  next.sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price))
  return next
}

export interface BidDepth {
  /** Total shares resting across every bid level. */
  sharesBid: number
  /** Whether any bid is on the book at all. */
  hasBid: boolean
  /** Whether the bid ladder can absorb the requested size. */
  coversSize: boolean
  /** Worst (lowest) price a market sell of `shares` would reach, or null if depth can't cover it. */
  fillsAllAtPrice: number | null
}

/**
 * Walk the bid ladder to answer "if I market-sold `shares` right now, what's available?".
 * Depth comes from the WebSocket book only (REST never fills it), so this is empty until a
 * live `book`/`price_change` frame for the token arrives.
 */
export function bidDepthForSize(quote: TokenQuote | undefined, shares: number): BidDepth {
  const bids = quote?.bids ?? []
  let sharesBid = 0
  let remaining = shares > 0 ? shares : 0
  let coversSize = !(shares > 0) && bids.length > 0
  let fillsAllAtPrice: number | null = null
  for (const level of bids) {
    sharesBid += level.size
    if (!coversSize && remaining > 0) {
      remaining -= level.size
      fillsAllAtPrice = level.price
      if (remaining <= 1e-9) coversSize = true
    }
  }
  return { sharesBid, hasBid: bids.length > 0, coversSize, fillsAllAtPrice: coversSize ? fillsAllAtPrice : null }
}

function patchQuote(map: TokenQuoteMap, assetId: string, patch: Partial<TokenQuote>) {
  map[assetId] = { ...(map[assetId] ?? emptyQuote()), ...patch }
}

/** Apply one (or an array of) raw CLOB frame(s) to the shared quote map, ignoring
 * tokens outside `wanted` — after a shrink the socket stays subscribed to dropped
 * tokens until the next replacement, and their frames must not repopulate the map
 * or fan out re-renders. Returns true if anything changed. */
function applyFrame(raw: unknown, map: TokenQuoteMap, wanted: Set<string>): boolean {
  if (Array.isArray(raw)) {
    let changed = false
    for (const item of raw) changed = applyFrame(item, map, wanted) || changed
    return changed
  }
  if (!raw || typeof raw !== 'object') return false

  const msg = raw as Record<string, unknown>
  switch (msg.event_type as string | undefined) {
    case 'book': {
      const assetId = msg.asset_id as string | undefined
      if (!assetId || !wanted.has(assetId)) return false
      const rawBids = (msg.bids as Array<{ price?: string; size?: string }>) ?? []
      const rawAsks = (msg.asks as Array<{ price?: string; size?: string }>) ?? []
      const bids = ladderFromRaw(rawBids, 'bid')
      const asks = ladderFromRaw(rawAsks, 'ask')
      // A full snapshot replaces both ladders; best prices come from the ladder tops.
      patchQuote(map, assetId, {
        bids,
        asks,
        bestBid: bids[0]?.price ?? null,
        bestAsk: asks[0]?.price ?? null,
      })
      return true
    }
    case 'price_change': {
      // Each item is one level delta for an asset (size 0 removes it) plus the resulting
      // top-of-book. Sizes let us keep the depth ladder live between full `book` snapshots.
      const items =
        (msg.price_changes as Array<{
          asset_id: string
          price?: string
          side?: string
          size?: string
          best_bid?: string
          best_ask?: string
        }>) ?? []
      let changed = false
      for (const item of items) {
        if (!wanted.has(item.asset_id)) continue
        const existing = map[item.asset_id] ?? emptyQuote()
        const patch: Partial<TokenQuote> = {
          bestBid: toNum(item.best_bid),
          bestAsk: toNum(item.best_ask),
        }
        const price = toNum(item.price)
        const size = toNum(item.size)
        if (price != null && size != null) {
          const side = (item.side ?? '').toUpperCase()
          if (side === 'BUY') patch.bids = upsertLevel(existing.bids, 'bid', price, size)
          else if (side === 'SELL') patch.asks = upsertLevel(existing.asks, 'ask', price, size)
        }
        patchQuote(map, item.asset_id, patch)
        changed = true
      }
      return changed
    }
    case 'best_bid_ask': {
      const assetId = msg.asset_id as string | undefined
      if (!assetId || !wanted.has(assetId)) return false
      patchQuote(map, assetId, { bestBid: toNum(msg.best_bid), bestAsk: toNum(msg.best_ask) })
      return true
    }
    case 'last_trade_price': {
      const assetId = msg.asset_id as string | undefined
      if (!assetId || !wanted.has(assetId)) return false
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
  /** Tokens some consumer currently wants — frames outside it are dropped. */
  private wanted = new Set<string>()
  /** Active (open) socket — the only one whose frames are applied. */
  private ws: WebSocket | null = null
  /** Replacement socket still connecting; promoted to `ws` on open (make-before-break). */
  private pendingWs: WebSocket | null = null
  private subscribedIds: string[] = []
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private connected = false
  /** Wall-clock ms of the last frame from the ACTIVE socket (book/quote or PONG). */
  private lastMessageAt = 0
  private listenersAttached = false
  private lastHealthCheck = 0

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
    if (!this.listenersAttached) this.attachGlobalListeners()
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
    const keep = new Set(next)
    for (const id of Object.keys(this.quotes)) {
      if (!keep.has(id)) delete this.quotes[id]
    }
    this.wanted = keep
    if (next.length === 0) {
      this.teardown()
      return
    }
    // While a replacement is already connecting, wait for it — promotion reconciles
    // again, so a union that grew during the handshake gets one follow-up socket
    // instead of killing every half-open handshake (the app-open resolve storm).
    // A hung handshake can't gate this forever: connectTimer abandons it.
    if (this.pendingWs) return
    // A shrink needs no resubscribe — keep the wider subscription and just serve the
    // narrower snapshots. Only a genuinely new token forces a socket replacement.
    const subscribed = new Set(this.subscribedIds)
    const covered = next.every((id) => subscribed.has(id))
    if (covered && this.ws && this.ws.readyState === WebSocket.OPEN) return
    this.openSocket(next)
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.connectTimer) clearTimeout(this.connectTimer)
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    this.pingTimer = null
    this.reconnectTimer = null
    this.connectTimer = null
    this.watchdogTimer = null
  }

  /** Debounced liveness check for the visibility/online listeners: revive a closed
   * socket, or force-reconnect (make-before-break) an OPEN-but-silent active one. */
  private checkFeedHealth() {
    if (this.subs.size === 0 || this.pendingWs) return
    const nowMs = Date.now()
    if (nowMs - this.lastHealthCheck < 2_000) return
    this.lastHealthCheck = nowMs
    const ids = this.union()
    if (ids.length === 0) return
    const closed = !this.ws || this.ws.readyState === WebSocket.CLOSED
    const stale =
      this.ws?.readyState === WebSocket.OPEN && nowMs - this.lastMessageAt > STALE_SOCKET_MS
    if (closed || stale) this.openSocket(ids)
  }

  private onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    this.checkFeedHealth()
  }

  private onOnline = () => this.checkFeedHealth()

  // Attached once (first subscriber), removed in teardown — many components subscribe,
  // so a per-subscribe attach would leak duplicate document/window listeners.
  private attachGlobalListeners() {
    if (this.listenersAttached) return
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility)
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline)
    this.listenersAttached = true
  }

  private detachGlobalListeners() {
    if (!this.listenersAttached) return
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility)
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline)
    this.listenersAttached = false
  }

  private clearConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
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

  private closeQuietly(ws: WebSocket) {
    this.detach(ws)
    try {
      ws.close()
    } catch {
      // ignore
    }
  }

  private scheduleReconnect() {
    if (this.subs.size === 0 || this.pendingWs || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket(this.union())
    }, RECONNECT_MS)
  }

  /**
   * Make-before-break: the previous socket keeps streaming while its replacement
   * connects, and is only closed once the new one is open. On app start the
   * per-market queries resolve staggered, so the token union grows several times
   * in quick succession — tearing down eagerly used to discard every in-flight
   * book snapshot and delay the first quotes by the whole churn.
   */
  private openSocket(ids: string[]) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearConnectTimer()
    if (this.pendingWs) this.closeQuietly(this.pendingWs)

    this.subscribedIds = ids
    const ws = new WebSocket(WS_URL)
    this.pendingWs = ws

    // Abandon a handshake that never completes — otherwise it gates reconcile
    // and scheduleReconnect until the browser's own (much longer) timeout.
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      if (ws !== this.pendingWs) return
      this.closeQuietly(ws)
      this.pendingWs = null
      if (!this.ws) this.setConnected(false)
      this.scheduleReconnect()
    }, CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      if (ws !== this.pendingWs) return
      this.clearConnectTimer()
      if (this.ws) this.closeQuietly(this.ws)
      if (this.pingTimer) clearInterval(this.pingTimer)
      if (this.watchdogTimer) clearInterval(this.watchdogTimer)
      this.ws = ws
      this.pendingWs = null
      this.lastMessageAt = Date.now()
      this.setConnected(true)
      ws.send(JSON.stringify({ assets_ids: ids, type: 'market', custom_feature_enabled: true }))
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING')
      }, PING_MS)
      // Force-reconnect (make-before-break) a half-open active socket the browser never
      // reported as closed: no frame AND no PONG for STALE_SOCKET_MS while still OPEN. The
      // `!pendingWs` guard means an in-flight reconcile/reconnect isn't fought.
      this.watchdogTimer = setInterval(() => {
        if (
          this.ws === ws &&
          !this.pendingWs &&
          ws.readyState === WebSocket.OPEN &&
          Date.now() - this.lastMessageAt > STALE_SOCKET_MS
        ) {
          const nextIds = this.union()
          if (nextIds.length > 0) this.openSocket(nextIds)
        }
      }, WATCHDOG_MS)
      // Tokens that arrived while this socket was connecting need one follow-up pass.
      this.scheduleReconcile()
    }

    ws.onmessage = (event) => {
      if (ws !== this.ws) return
      this.lastMessageAt = Date.now()
      if (event.data === 'PONG') return
      try {
        if (applyFrame(JSON.parse(event.data as string), this.quotes, this.wanted)) this.notifyQuotes()
      } catch {
        // ignore malformed frames
      }
    }

    ws.onclose = () => {
      if (ws === this.pendingWs) {
        // Never opened — the active socket (if any) is still streaming.
        this.clearConnectTimer()
        this.pendingWs = null
        if (!this.ws) this.setConnected(false)
        this.scheduleReconnect()
        return
      }
      if (ws !== this.ws) return
      this.setConnected(false)
      if (this.pingTimer) {
        clearInterval(this.pingTimer)
        this.pingTimer = null
      }
      // Clear the watchdog too (onopen only recreates it on a successful promotion): a
      // persistently-failing reconnect would otherwise leak a no-op interval pinning this ws.
      if (this.watchdogTimer) {
        clearInterval(this.watchdogTimer)
        this.watchdogTimer = null
      }
      this.ws = null
      this.scheduleReconnect()
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
    this.detachGlobalListeners()
    if (this.ws) {
      this.closeQuietly(this.ws)
      this.ws = null
    }
    if (this.pendingWs) {
      this.closeQuietly(this.pendingWs)
      this.pendingWs = null
    }
    this.subscribedIds = []
    this.quotes = {}
    this.wanted = new Set()
    this.setConnected(false)
  }
}

export const clobSocket = new ClobSocket()
