/**
 * Node port of the browser CLOB market socket (src/lib/clobSocket.ts), for the
 * bot. Where the browser socket exists to render quotes, this one exists to feed
 * the MAKER paper-strategy's fill simulator (docs/maker-paper-strategy.md, Phase 0):
 * it maintains a live per-token order book (depth ladders) AND a trade tape
 * (last_trade_price prints) — the two things gamma top-of-book can't give us and
 * that an honest resting-limit fill model requires.
 *
 * Single consumer (the bot loop), so this is much simpler than the browser
 * multiplexer: no per-component subscriptions, no document/visibility listeners.
 * The tradable token set changes as windows roll, so `setTokens` reconciles the
 * subscription; the book/tape maps persist across a resubscribe so a rollover
 * doesn't wipe history (only a brief <1s gap in prints while the new socket opens).
 * Uses Node's global WebSocket (v22+), same as sources/chainlink.ts.
 * @see https://docs.polymarket.com/CLOB/websocket/market-channel
 */
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const PING_MS = 10_000
const RECONNECT_MS = 2_000
/** No frame (book/quote/trade OR PONG) for this long on an OPEN socket → force-reconnect. */
const STALE_SOCKET_MS = 30_000
const WATCHDOG_MS = 5_000
/** Trade tape retention per token — a few windows' worth; the fill sim only reads the recent tail. */
const TAPE_MS = 15 * 60 * 1000
const MAX_TAPE = 4_000

/** One resting order-book price level. */
export interface BookLevel {
  price: number
  size: number
}

/** Live top-of-book + full depth ladders for one token. */
export interface TokenBook {
  bestBid: number | null
  bestAsk: number | null
  /** Highest price first. */
  bids: BookLevel[]
  /** Lowest price first. */
  asks: BookLevel[]
}

/**
 * One trade print off the `last_trade_price` feed — the fill trigger. `side` is
 * the taker's side (BUY = someone lifted the ask, SELL = someone hit the bid), so
 * a resting BUY fills on a SELL print at ≤ its price. size/side are captured when
 * the feed provides them; price+ts are always present.
 */
export interface TradePrint {
  price: number
  size: number | null
  side: 'buy' | 'sell' | null
  ts: number
}

function toNum(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Parse a raw book side into a sorted ladder (best price first). */
function ladderFromRaw(raw: Array<{ price?: string; size?: string }>, side: 'bid' | 'ask'): BookLevel[] {
  const out: BookLevel[] = []
  for (const level of raw) {
    const price = toNum(level.price)
    const size = toNum(level.size)
    if (price != null && size != null && size > 0) out.push({ price, size })
  }
  out.sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price))
  return out
}

/** Upsert one level into a ladder, returning a NEW array (size 0 removes it). */
function upsertLevel(ladder: BookLevel[], side: 'bid' | 'ask', price: number, size: number): BookLevel[] {
  const next = ladder.filter((l) => l.price !== price)
  if (size > 0) next.push({ price, size })
  next.sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price))
  return next
}

function emptyBook(): TokenBook {
  return { bestBid: null, bestAsk: null, bids: [], asks: [] }
}

export class ClobMarketStream {
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  /** Tokens we currently want subscribed (drives the assets_ids frame). */
  private desired = new Set<string>()
  /** assets_ids the OPEN socket actually subscribed — a resubscribe is only forced when `desired` outgrows this. */
  private subscribedIds: string[] = []
  /** Live book per token, kept across resubscribes. */
  private books: Record<string, TokenBook> = {}
  /** Trade tape per token (append order ≈ ts order). */
  private tape: Record<string, TradePrint[]> = {}
  private onTrade?: (tokenId: string, print: TradePrint) => void
  /** Wall-clock ms of the last frame from the active socket (any frame or PONG). */
  private lastMessageAt = 0
  /** Guards against overlapping opens while a handshake is in flight. */
  private opening = false
  connected = false

  start(onTrade?: (tokenId: string, print: TradePrint) => void): void {
    this.onTrade = onTrade
  }

  stop(): void {
    this.clearTimers()
    try {
      this.ws?.close()
    } catch {
      // ignore
    }
    this.ws = null
    this.connected = false
    this.opening = false
  }

  /**
   * Set the full set of tokens to stream. Opens the socket on first non-empty set,
   * resubscribes when a genuinely new token appears (a shrink keeps the wider
   * subscription — we just stop reading the dropped token), and tears down when the
   * set goes empty. Idempotent when nothing changed.
   */
  setTokens(tokenIds: string[]): void {
    const next = new Set(tokenIds.filter(Boolean))
    this.desired = next
    // Drop book/tape for tokens no consumer wants anymore (bounded memory).
    for (const id of Object.keys(this.books)) if (!next.has(id)) delete this.books[id]
    for (const id of Object.keys(this.tape)) if (!next.has(id)) delete this.tape[id]

    if (next.size === 0) {
      this.stop()
      return
    }
    const covered = [...next].every((id) => this.subscribedIds.includes(id))
    const open = this.ws?.readyState === WebSocket.OPEN
    if (open && covered) return
    if (this.opening) return // handshake in flight; onopen reconciles again
    this.open()
  }

  // --- queries the maker fill sim reads ---

  book(tokenId: string): TokenBook | null {
    return this.books[tokenId] ?? null
  }

  bestBidAsk(tokenId: string): { bid: number | null; ask: number | null } {
    const b = this.books[tokenId]
    return { bid: b?.bestBid ?? null, ask: b?.bestAsk ?? null }
  }

  /** Resting size at an exact price level on a side (for L2 queue-ahead seeding). 0 if none. */
  depthAt(tokenId: string, side: 'bid' | 'ask', price: number): number {
    const ladder = side === 'bid' ? this.books[tokenId]?.bids : this.books[tokenId]?.asks
    if (!ladder) return 0
    const level = ladder.find((l) => Math.abs(l.price - price) < 1e-9)
    return level?.size ?? 0
  }

  /** Trade prints at/after `sinceMs`, oldest first (the fill trigger since last step). */
  tradesSince(tokenId: string, sinceMs: number): TradePrint[] {
    const prints = this.tape[tokenId]
    if (!prints?.length) return []
    let lo = 0
    let hi = prints.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (prints[mid].ts < sinceMs) lo = mid + 1
      else hi = mid
    }
    return prints.slice(lo)
  }

  /** Lightweight snapshot for the Phase-0 probe / status line. */
  stats(): { connected: boolean; tokens: number; withBook: number; totalPrints: number } {
    const tokens = this.desired.size
    let withBook = 0
    let totalPrints = 0
    for (const id of this.desired) {
      const b = this.books[id]
      if (b && (b.bestBid != null || b.bestAsk != null)) withBook += 1
      totalPrints += this.tape[id]?.length ?? 0
    }
    return { connected: this.connected, tokens, withBook, totalPrints }
  }

  // --- internals ---

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    this.pingTimer = this.reconnectTimer = this.watchdogTimer = null
  }

  private scheduleReconnect(): void {
    if (this.desired.size === 0 || this.reconnectTimer || this.opening) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, RECONNECT_MS)
  }

  private recordTrade(tokenId: string, print: TradePrint): void {
    const arr = this.tape[tokenId] ?? []
    const last = arr[arr.length - 1]
    // Drop an exact re-send (the feed re-broadcasts the last trade on snapshot/reconnect).
    if (last && last.ts === print.ts && last.price === print.price && last.size === print.size && last.side === print.side) {
      return
    }
    arr.push(print)
    const cutoff = Date.now() - TAPE_MS
    while (arr.length > 0 && arr[0].ts < cutoff) arr.shift()
    if (arr.length > MAX_TAPE) arr.splice(0, arr.length - MAX_TAPE)
    this.tape[tokenId] = arr
    this.onTrade?.(tokenId, print)
  }

  /** Apply one raw frame (or array) to the book/tape maps, ignoring unwanted tokens. */
  private applyFrame(raw: unknown): void {
    if (Array.isArray(raw)) {
      for (const item of raw) this.applyFrame(item)
      return
    }
    if (!raw || typeof raw !== 'object') return
    const msg = raw as Record<string, unknown>

    switch (msg.event_type as string | undefined) {
      case 'book': {
        const id = msg.asset_id as string | undefined
        if (!id || !this.desired.has(id)) return
        const bids = ladderFromRaw((msg.bids as Array<{ price?: string; size?: string }>) ?? [], 'bid')
        const asks = ladderFromRaw((msg.asks as Array<{ price?: string; size?: string }>) ?? [], 'ask')
        this.books[id] = { bids, asks, bestBid: bids[0]?.price ?? null, bestAsk: asks[0]?.price ?? null }
        return
      }
      case 'price_change': {
        const items =
          (msg.price_changes as Array<{
            asset_id: string
            price?: string
            side?: string
            size?: string
            best_bid?: string
            best_ask?: string
          }>) ?? []
        for (const item of items) {
          if (!this.desired.has(item.asset_id)) continue
          const cur = this.books[item.asset_id] ?? emptyBook()
          let { bids, asks } = cur
          const price = toNum(item.price)
          const size = toNum(item.size)
          if (price != null && size != null) {
            const side = (item.side ?? '').toUpperCase()
            if (side === 'BUY') bids = upsertLevel(bids, 'bid', price, size)
            else if (side === 'SELL') asks = upsertLevel(asks, 'ask', price, size)
          }
          this.books[item.asset_id] = {
            bids,
            asks,
            bestBid: toNum(item.best_bid) ?? bids[0]?.price ?? null,
            bestAsk: toNum(item.best_ask) ?? asks[0]?.price ?? null,
          }
        }
        return
      }
      case 'best_bid_ask': {
        const id = msg.asset_id as string | undefined
        if (!id || !this.desired.has(id)) return
        const cur = this.books[id] ?? emptyBook()
        this.books[id] = { ...cur, bestBid: toNum(msg.best_bid), bestAsk: toNum(msg.best_ask) }
        return
      }
      case 'last_trade_price': {
        const id = msg.asset_id as string | undefined
        if (!id || !this.desired.has(id)) return
        const price = toNum(msg.price)
        if (price == null) return
        const sideRaw = String(msg.side ?? '').toLowerCase()
        const side: TradePrint['side'] = sideRaw === 'buy' ? 'buy' : sideRaw === 'sell' ? 'sell' : null
        const ts = toNum(msg.timestamp) ?? Date.now()
        this.recordTrade(id, { price, size: toNum(msg.size), side, ts })
        return
      }
      default:
        return
    }
  }

  private open(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const ids = [...this.desired].sort()
    if (ids.length === 0) return
    this.opening = true
    // Close-before-open: detach the old socket's handlers first so its onclose
    // can't fire a competing reconnect, then replace it. Brief (<1s) gap in prints
    // during the handshake; the book/tape maps persist so no history is lost.
    const old = this.ws
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null
      try {
        old.close()
      } catch {
        // ignore
      }
    }
    const ws = new WebSocket(WS_URL)
    this.ws = ws

    ws.onopen = () => {
      if (ws !== this.ws) return
      this.opening = false
      this.connected = true
      this.lastMessageAt = Date.now()
      this.subscribedIds = ids
      ws.send(JSON.stringify({ assets_ids: ids, type: 'market', custom_feature_enabled: true }))
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING')
      }, PING_MS)
      if (this.watchdogTimer) clearInterval(this.watchdogTimer)
      this.watchdogTimer = setInterval(() => {
        if (
          this.ws === ws &&
          !this.opening &&
          ws.readyState === WebSocket.OPEN &&
          Date.now() - this.lastMessageAt > STALE_SOCKET_MS
        ) {
          this.open() // silent/half-open socket — replace it
        }
      }, WATCHDOG_MS)
      // Tokens added during the handshake need one follow-up pass.
      if (![...this.desired].every((id) => this.subscribedIds.includes(id))) this.open()
    }

    ws.onmessage = (event: MessageEvent) => {
      if (ws !== this.ws) return
      this.lastMessageAt = Date.now()
      if (event.data === 'PONG') return
      try {
        this.applyFrame(JSON.parse(event.data as string))
      } catch {
        // ignore malformed frames
      }
    }

    ws.onclose = () => {
      if (ws !== this.ws) return
      this.opening = false
      this.connected = false
      if (this.pingTimer) clearInterval(this.pingTimer)
      if (this.watchdogTimer) clearInterval(this.watchdogTimer)
      this.pingTimer = this.watchdogTimer = null
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
}
