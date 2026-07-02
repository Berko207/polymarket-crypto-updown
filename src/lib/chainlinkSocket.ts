/**
 * Multiplexed Polymarket RTDS Chainlink price stream.
 * @see https://docs.polymarket.com/market-data/websocket/rtds
 */

const WS_URL = 'wss://ws-live-data.polymarket.com'
const PING_MS = 5_000
const RECONNECT_MS = 2_000
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
  private connected = false

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

  private notify() {
    for (const sub of this.subs) sub.onUpdate(this.snapshot(sub.symbols))
  }

  latestTick(pair: string): ChainlinkTick | null {
    return this.prices[pair] ?? null
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

  private recordTick(symbol: string, tick: ChainlinkTick) {
    const arr = this.history[symbol] ?? []
    const last = arr[arr.length - 1]
    if (last?.timestamp === tick.timestamp && last.value === tick.value) return

    arr.push(tick)
    const cutoff = Date.now() - HISTORY_MS
    while (arr.length > 0 && arr[0].timestamp < cutoff) arr.shift()
    if (arr.length > MAX_HISTORY_TICKS) arr.splice(0, arr.length - MAX_HISTORY_TICKS)
    this.history[symbol] = arr
  }

  private applyMessage(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false
    const msg = raw as Record<string, unknown>
    if (msg.topic !== 'crypto_prices_chainlink') return false

    const payload = msg.payload as Record<string, unknown> | undefined
    if (!payload) return false

    const symbol = String(payload.symbol ?? '').toLowerCase()
    const value = Number(payload.value)
    const timestamp = Number(payload.timestamp ?? msg.timestamp)
    if (!symbol || !Number.isFinite(value)) return false

    const tick: ChainlinkTick = {
      value,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    }
    if (payload.is_carried_forward === true) tick.carried = true

    const prev = this.prices[symbol]
    if (prev?.value === tick.value && prev.timestamp === tick.timestamp) return false

    this.prices[symbol] = tick
    this.recordTick(symbol, tick)
    return true
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
      this.setConnected(true)
      ws.send(
        JSON.stringify({
          action: 'subscribe',
          subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: '' }],
        }),
      )
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING')
      }, PING_MS)
    }

    ws.onmessage = (event) => {
      if (ws !== this.ws) return
      if (event.data === 'PONG') return
      try {
        if (this.applyMessage(JSON.parse(event.data as string))) this.notify()
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
