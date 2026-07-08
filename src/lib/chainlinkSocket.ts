/**
 * Multiplexed Polymarket RTDS Chainlink price stream.
 * @see https://docs.polymarket.com/market-data/websocket/rtds
 */

const WS_URL = 'wss://ws-live-data.polymarket.com'
const PING_MS = 5_000
const RECONNECT_MS = 2_000
/** No frame (tick OR PONG) for this long on an OPEN socket → force-reconnect: the
 * browser never surfaced the half-open/silent connection (sleep, VPN flip) as closed. */
const STALE_SOCKET_MS = 25_000
/** Watchdog cadence — well under STALE_SOCKET_MS so a stall is caught within ~one interval. */
const WATCHDOG_MS = 5_000
/** Re-send per-symbol subs — RTDS snapshots are the live refresh path. */
const REFRESH_MS = 5_000
/** Keep ticks long enough to cover a 4h window plus slack. */
const HISTORY_MS = 5 * 60 * 60 * 1000
const MAX_HISTORY_TICKS = 8_000

export interface ChainlinkTick {
  value: number
  /** Oracle measurement time (ms). */
  timestamp: number
  /** RTDS re-emitted a stale print (`is_carried_forward`) — not a fresh oracle observation. */
  carried?: boolean
}

export type ChainlinkPriceMap = Record<string, ChainlinkTick>

interface Subscription {
  symbols: Set<string>
  onUpdate: (prices: ChainlinkPriceMap) => void
  onConnectedChange?: (connected: boolean) => void
}

class ChainlinkSocket {
  private subs = new Set<Subscription>()
  private prices: ChainlinkPriceMap = {}
  private history: Record<string, ChainlinkTick[]> = {}
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private connected = false
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private seeded = new Set<string>()
  /** Wall-clock ms of the last frame from the active socket (tick OR PONG). */
  private lastMessageAt = 0
  private listenersAttached = false
  private lastHealthCheck = 0

  subscribe(
    symbols: string[],
    onUpdate: (prices: ChainlinkPriceMap) => void,
    onConnectedChange?: (connected: boolean) => void,
  ): () => void {
    const sub: Subscription = {
      symbols: new Set(symbols.filter(Boolean)),
      onUpdate,
      onConnectedChange,
    }
    this.subs.add(sub)
    if (this.subs.size === 1) this.attachGlobalListeners()
    onUpdate(this.snapshot(sub.symbols))
    onConnectedChange?.(this.connected)
    this.ensureSocket()
    return () => {
      this.subs.delete(sub)
      if (this.subs.size === 0) this.teardown()
    }
  }

  private snapshot(symbols: Set<string>): ChainlinkPriceMap {
    const out: ChainlinkPriceMap = {}
    for (const sym of symbols) {
      const tick = this.prices[sym]
      if (tick) out[sym] = tick
    }
    return out
  }

  private ensureSocket() {
    if (this.subs.size === 0) return
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return
    this.openSocket()
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.pingTimer = null
    this.reconnectTimer = null
    this.watchdogTimer = null
    this.refreshTimer = null
  }

  private allSymbols(): string[] {
    const out = new Set<string>()
    for (const sub of this.subs) for (const sym of sub.symbols) out.add(sym)
    return [...out]
  }

  private subscribeAll(ws: WebSocket): void {
    for (const symbol of this.allSymbols()) {
      ws.send(
        JSON.stringify({
          action: 'subscribe',
          subscriptions: [
            {
              topic: 'crypto_prices_chainlink',
              type: '*',
              filters: JSON.stringify({ symbol }),
            },
          ],
        }),
      )
    }
  }

  /** Debounced liveness check shared by the visibility/online listeners: revive a
   * closed socket, or force-reconnect an OPEN-but-silent (half-open) one. */
  private checkFeedHealth() {
    if (this.subs.size === 0) return
    const nowMs = Date.now()
    if (nowMs - this.lastHealthCheck < 2_000) return
    this.lastHealthCheck = nowMs
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.ensureSocket()
    } else if (this.ws.readyState === WebSocket.OPEN && nowMs - this.lastMessageAt > STALE_SOCKET_MS) {
      this.openSocket()
    }
  }

  private onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    this.checkFeedHealth()
  }

  private onOnline = () => this.checkFeedHealth()

  // Attached once on the 0→1 subscriber transition, removed in teardown (1→0) — many
  // components subscribe, so per-subscribe attach would leak duplicate listeners.
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

  private notify() {
    for (const sub of this.subs) sub.onUpdate(this.snapshot(sub.symbols))
  }

  latestTick(pair: string): ChainlinkTick | null {
    return this.prices[pair] ?? null
  }

  /** Wall-clock ms since the last frame from the active socket, or Infinity when no
   * socket is open — the display-staleness signal consumers gate "live" on. Backed by
   * PING/PONG, so a calm feed with sparse oracle prints still reads as fresh. */
  msSinceLastMessage(): number {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Infinity
    return Date.now() - this.lastMessageAt
  }

  /** Retained ticks at/after `sinceMs`, oldest first (bounded by the 5h ring buffer). */
  ticksSince(pair: string, sinceMs: number): ChainlinkTick[] {
    const ticks = this.history[pair]
    if (!ticks?.length) return []
    // Ticks are append-ordered by timestamp — binary search the start.
    let lo = 0
    let hi = ticks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (ticks[mid].timestamp < sinceMs) lo = mid + 1
      else hi = mid
    }
    return ticks.slice(lo)
  }

  // A resolved strike is immutable (first tick at/after a past boundary never changes),
  // and callers ask per render — cache hits keep this O(1) instead of a history scan.
  private strikeCache = new Map<string, number>()

  /**
   * Chainlink price at window open — first tick at/after the boundary.
   * Rolling windows use a wider slop because ticks may be sparse.
   */
  strikeAtBoundary(pair: string, boundaryMs: number, rolling = false): number | null {
    const key = `${pair}:${boundaryMs}:${rolling ? 1 : 0}`
    const cached = this.strikeCache.get(key)
    if (cached != null) return cached

    const value = this.firstPriceAtOrAfter(pair, boundaryMs, rolling ? 120_000 : 60_000)
    if (value != null) {
      this.strikeCache.set(key, value)
      // Insertion-ordered trim — old windows' strikes are never asked for again.
      if (this.strikeCache.size > 256) {
        const oldest = this.strikeCache.keys().next().value
        if (oldest != null) this.strikeCache.delete(oldest)
      }
    }
    return value
  }

  /**
   * Opening tick at/after a window boundary. Rejects ticks too far after the
   * boundary — otherwise every missed window gets the same stale history tick.
   */
  firstPriceAtOrAfter(pair: string, boundaryMs: number, maxSlopMs = 60_000): number | null {
    const ticks = this.history[pair]
    if (!ticks?.length) return null
    for (const tick of ticks) {
      if (tick.timestamp >= boundaryMs) {
        if (tick.timestamp - boundaryMs <= maxSlopMs) return tick.value
        return null
      }
    }
    return null
  }

  private recordQuiet(symbol: string, tick: ChainlinkTick): void {
    const arr = this.history[symbol] ?? []
    const last = arr[arr.length - 1]
    if (last?.timestamp === tick.timestamp && last.value === tick.value) return
    if (last && tick.timestamp < last.timestamp) return
    arr.push(tick)
    const cutoff = Date.now() - HISTORY_MS
    while (arr.length > 0 && arr[0].timestamp < cutoff) arr.shift()
    if (arr.length > MAX_HISTORY_TICKS) arr.splice(0, arr.length - MAX_HISTORY_TICKS)
    this.history[symbol] = arr
  }

  private ingest(symbol: string, tick: ChainlinkTick): boolean {
    const prev = this.prices[symbol]
    if (prev?.value === tick.value && prev.timestamp === tick.timestamp) return false
    this.prices[symbol] = tick
    this.recordQuiet(symbol, tick)
    return true
  }

  private parseSnapshotRows(rows: unknown[]): ChainlinkTick[] {
    const points: ChainlinkTick[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const pt = row as Record<string, unknown>
      const value = Number(pt.value)
      const timestamp = Number(pt.timestamp)
      if (!Number.isFinite(value) || !Number.isFinite(timestamp)) continue
      points.push({ value, timestamp })
    }
    points.sort((a, b) => a.timestamp - b.timestamp)
    return points
  }

  private applySnapshot(symbol: string, rows: unknown[]): boolean {
    const points = this.parseSnapshotRows(rows)
    if (!points.length) return false

    if (!this.seeded.has(symbol)) {
      for (let i = 0; i < points.length - 1; i++) this.recordQuiet(symbol, points[i]!)
      this.seeded.add(symbol)
      return this.ingest(symbol, points[points.length - 1]!)
    }

    const latestTs = this.prices[symbol]?.timestamp ?? 0
    let changed = false
    for (const p of points) {
      if (p.timestamp > latestTs && this.ingest(symbol, p)) changed = true
    }
    return changed
  }

  private applyMessage(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false
    const msg = raw as Record<string, unknown>
    const topic = msg.topic
    if (topic !== 'crypto_prices_chainlink' && topic !== 'crypto_prices') return false

    const payload = msg.payload as Record<string, unknown> | undefined
    if (!payload) return false

    const symbol = String(payload.symbol ?? '').toLowerCase()
    if (!symbol.includes('/')) return false

    const data = payload.data
    if (Array.isArray(data)) return this.applySnapshot(symbol, data)

    const value = Number(payload.value)
    const timestamp = Number(payload.timestamp ?? msg.timestamp)
    if (!Number.isFinite(value)) return false

    const tick: ChainlinkTick = {
      value,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    }
    if (payload.is_carried_forward === true) tick.carried = true
    return this.ingest(symbol, tick)
  }

  private openSocket() {
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

    const ws = new WebSocket(WS_URL)
    this.ws = ws

    ws.onopen = () => {
      if (ws !== this.ws) return
      this.lastMessageAt = Date.now()
      this.setConnected(true)
      this.subscribeAll(ws)
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING')
      }, PING_MS)
      this.refreshTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) this.subscribeAll(ws)
      }, REFRESH_MS)
      // Force-reconnect a half-open socket the browser never reported as closed:
      // no tick AND no PONG for STALE_SOCKET_MS while still OPEN means it's dead.
      this.watchdogTimer = setInterval(() => {
        if (
          this.ws === ws &&
          ws.readyState === WebSocket.OPEN &&
          Date.now() - this.lastMessageAt > STALE_SOCKET_MS
        ) {
          this.openSocket()
        }
      }, WATCHDOG_MS)
    }

    ws.onmessage = (event) => {
      if (ws !== this.ws) return
      this.lastMessageAt = Date.now()
      const raw = String(event.data)
      if (!raw.trim() || raw === 'PONG') return
      try {
        if (this.applyMessage(JSON.parse(raw))) this.notify()
      } catch {
        // ignore malformed frames
      }
    }

    ws.onclose = () => {
      if (ws !== this.ws) return
      this.setConnected(false)
      this.clearTimers()
      this.ws = null
      this.seeded.clear()
      if (this.subs.size > 0) {
        this.reconnectTimer = setTimeout(() => this.openSocket(), RECONNECT_MS)
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
    this.detachGlobalListeners()
    if (this.ws) {
      this.detach(this.ws)
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    this.setConnected(false)
  }
}

export const chainlinkSocket = new ChainlinkSocket()
