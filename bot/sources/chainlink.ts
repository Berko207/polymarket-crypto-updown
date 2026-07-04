/**
 * Node port of the browser RTDS Chainlink stream (src/lib/chainlinkSocket.ts).
 * Single consumer: maintains a per-symbol ring buffer and emits each fresh tick
 * to a callback (for DB persistence). Uses Node's global WebSocket (v22+).
 * @see https://docs.polymarket.com/market-data/websocket/rtds
 */
const WS_URL = 'wss://ws-live-data.polymarket.com'
const PING_MS = 5_000
const RECONNECT_MS = 2_000
const HISTORY_MS = 5 * 60 * 60 * 1000
const MAX_HISTORY_TICKS = 8_000

export interface Tick {
  value: number
  timestamp: number
  carried?: boolean
}

export class ChainlinkStream {
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private history: Record<string, Tick[]> = {}
  private latestBySymbol: Record<string, Tick> = {}
  private onTick?: (symbol: string, tick: Tick) => void
  connected = false

  start(onTick?: (symbol: string, tick: Tick) => void): void {
    this.onTick = onTick
    this.open()
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.pingTimer = this.reconnectTimer = null
    try {
      this.ws?.close()
    } catch {
      // ignore
    }
    this.ws = null
  }

  latest(pair: string): Tick | null {
    return this.latestBySymbol[pair] ?? null
  }

  /** Retained ticks at/after `sinceMs`, oldest first. */
  ticksSince(pair: string, sinceMs: number): Tick[] {
    const ticks = this.history[pair]
    if (!ticks?.length) return []
    let lo = 0
    let hi = ticks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (ticks[mid].timestamp < sinceMs) lo = mid + 1
      else hi = mid
    }
    return ticks.slice(lo)
  }

  /** First tick at/after a boundary (window open/close), within slop. */
  firstPriceAtOrAfter(pair: string, boundaryMs: number, maxSlopMs = 60_000): number | null {
    const ticks = this.history[pair]
    if (!ticks?.length) return null
    for (const tick of ticks) {
      if (tick.timestamp >= boundaryMs) {
        return tick.timestamp - boundaryMs <= maxSlopMs ? tick.value : null
      }
    }
    return null
  }

  private record(symbol: string, tick: Tick): void {
    const arr = this.history[symbol] ?? []
    const last = arr[arr.length - 1]
    if (last?.timestamp === tick.timestamp && last.value === tick.value) return
    arr.push(tick)
    const cutoff = Date.now() - HISTORY_MS
    while (arr.length > 0 && arr[0].timestamp < cutoff) arr.shift()
    if (arr.length > MAX_HISTORY_TICKS) arr.splice(0, arr.length - MAX_HISTORY_TICKS)
    this.history[symbol] = arr
  }

  private apply(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const msg = raw as Record<string, unknown>
    if (msg.topic !== 'crypto_prices_chainlink') return
    const payload = msg.payload as Record<string, unknown> | undefined
    if (!payload) return

    const symbol = String(payload.symbol ?? '').toLowerCase()
    const value = Number(payload.value)
    const timestamp = Number(payload.timestamp ?? msg.timestamp)
    if (!symbol || !Number.isFinite(value)) return

    const tick: Tick = { value, timestamp: Number.isFinite(timestamp) ? timestamp : Date.now() }
    if (payload.is_carried_forward === true) tick.carried = true

    const prev = this.latestBySymbol[symbol]
    if (prev?.value === tick.value && prev.timestamp === tick.timestamp) return

    this.latestBySymbol[symbol] = tick
    this.record(symbol, tick)
    this.onTick?.(symbol, tick)
  }

  private open(): void {
    const ws = new WebSocket(WS_URL)
    this.ws = ws

    ws.onopen = () => {
      if (ws !== this.ws) return
      this.connected = true
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

    ws.onmessage = (event: MessageEvent) => {
      if (ws !== this.ws) return
      if (event.data === 'PONG') return
      try {
        this.apply(JSON.parse(event.data as string))
      } catch {
        // ignore malformed frames
      }
    }

    ws.onclose = () => {
      if (ws !== this.ws) return
      this.connected = false
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = null
      this.ws = null
      this.reconnectTimer = setTimeout(() => this.open(), RECONNECT_MS)
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
