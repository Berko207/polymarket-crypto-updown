/**
 * Node port of the browser RTDS Chainlink stream (src/lib/chainlinkSocket.ts).
 * Single consumer: maintains a per-symbol ring buffer and emits each fresh tick
 * to a callback (for DB persistence). Uses Node's global WebSocket (v22+).
 *
 * RTDS (2026-07): the catch-all `filters: ""` subscription is silent — subscribe
 * per symbol (`{"symbol":"btc/usd"}`). Responses arrive on `crypto_prices` with a
 * `payload.data[]` snapshot; live `update` frames are rare — re-subscribe to refresh.
 * @see https://docs.polymarket.com/market-data/websocket/rtds
 */
import { CHAINLINK_PAIR } from '../../src/lib/cryptoPrice'

const WS_URL = 'wss://ws-live-data.polymarket.com'
const PING_MS = 5_000
const RECONNECT_MS = 2_000
/** Re-send per-symbol subs so snapshots stay within ~2s of wall clock. */
const REFRESH_MS = 5_000
const STALE_SOCKET_MS = 25_000
const WATCHDOG_MS = 5_000
const HISTORY_MS = 5 * 60 * 60 * 1000
const MAX_HISTORY_TICKS = 8_000

const DEFAULT_SYMBOLS = [...new Set(Object.values(CHAINLINK_PAIR).filter(Boolean))] as string[]

export interface Tick {
  value: number
  timestamp: number
  carried?: boolean
}

export class ChainlinkStream {
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private history: Record<string, Tick[]> = {}
  private latestBySymbol: Record<string, Tick> = {}
  private seeded = new Set<string>()
  private onTick?: (symbol: string, tick: Tick) => void
  private readonly symbols: string[]
  private lastMessageAt = 0
  connected = false

  constructor(symbols: string[] = DEFAULT_SYMBOLS) {
    this.symbols = symbols.length ? symbols : DEFAULT_SYMBOLS
  }

  start(onTick?: (symbol: string, tick: Tick) => void): void {
    this.onTick = onTick
    this.open()
  }

  stop(): void {
    this.clearTimers()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    try {
      this.ws?.close()
    } catch {
      // ignore
    }
    this.ws = null
    this.connected = false
  }

  latest(pair: string): Tick | null {
    return this.latestBySymbol[pair] ?? null
  }

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

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    this.pingTimer = this.refreshTimer = this.watchdogTimer = null
  }

  /** Append to history only — keeps timestamp order, no onTick callback. */
  private recordQuiet(symbol: string, tick: Tick): void {
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

  private ingest(symbol: string, tick: Tick): void {
    const prev = this.latestBySymbol[symbol]
    if (prev?.value === tick.value && prev.timestamp === tick.timestamp) return
    this.latestBySymbol[symbol] = tick
    this.recordQuiet(symbol, tick)
    this.onTick?.(symbol, tick)
  }

  private subscribeAll(ws: WebSocket): void {
    for (const symbol of this.symbols) {
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

  private parseSnapshotRows(rows: unknown[]): Tick[] {
    const points: Tick[] = []
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

  /** Snapshot batches must not be replayed wholesale — that scrambles chart order. */
  private applySnapshot(symbol: string, rows: unknown[]): void {
    const points = this.parseSnapshotRows(rows)
    if (!points.length) return

    if (!this.seeded.has(symbol)) {
      for (let i = 0; i < points.length - 1; i++) this.recordQuiet(symbol, points[i]!)
      this.seeded.add(symbol)
      this.ingest(symbol, points[points.length - 1]!)
      return
    }

    const latestTs = this.latestBySymbol[symbol]?.timestamp ?? 0
    for (const p of points) {
      if (p.timestamp > latestTs) this.ingest(symbol, p)
    }
  }

  private apply(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const msg = raw as Record<string, unknown>
    const topic = msg.topic
    if (topic !== 'crypto_prices_chainlink' && topic !== 'crypto_prices') return
    const payload = msg.payload as Record<string, unknown> | undefined
    if (!payload) return

    const symbol = String(payload.symbol ?? '').toLowerCase()
    if (!symbol.includes('/')) return

    const data = payload.data
    if (Array.isArray(data)) {
      this.applySnapshot(symbol, data)
      return
    }

    const value = Number(payload.value)
    const timestamp = Number(payload.timestamp ?? msg.timestamp)
    if (!Number.isFinite(value)) return

    const tick: Tick = { value, timestamp: Number.isFinite(timestamp) ? timestamp : Date.now() }
    if (payload.is_carried_forward === true) tick.carried = true
    this.ingest(symbol, tick)
  }

  private open(): void {
    this.clearTimers()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
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
      this.connected = true
      this.subscribeAll(ws)
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING')
      }, PING_MS)
      this.refreshTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) this.subscribeAll(ws)
      }, REFRESH_MS)
      this.watchdogTimer = setInterval(() => {
        if (
          this.ws === ws &&
          ws.readyState === WebSocket.OPEN &&
          Date.now() - this.lastMessageAt > STALE_SOCKET_MS
        ) {
          this.open()
        }
      }, WATCHDOG_MS)
    }

    ws.onmessage = (event: MessageEvent) => {
      if (ws !== this.ws) return
      this.lastMessageAt = Date.now()
      const raw = String(event.data)
      if (!raw.trim() || raw === 'PONG') return
      try {
        this.apply(JSON.parse(raw))
      } catch {
        // ignore malformed frames
      }
    }

    ws.onclose = () => {
      if (ws !== this.ws) return
      this.connected = false
      this.clearTimers()
      this.ws = null
      this.seeded.clear()
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
