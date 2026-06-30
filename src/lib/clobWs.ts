const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const PING_MS = 10_000
const RECONNECT_MS = 2_000

export interface TokenQuote {
  bestBid: number | null
  bestAsk: number | null
  lastTrade: number | null
}

export interface LiveQuoteUpdate {
  upPrice: number | null
  downPrice: number | null
  bestBidUp: number | null
  bestAskUp: number | null
  bestBidDown: number | null
  bestAskDown: number | null
}

type QuoteMap = Record<string, TokenQuote>

function emptyQuote(): TokenQuote {
  return { bestBid: null, bestAsk: null, lastTrade: null }
}

function toNum(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Midpoint of bid/ask, falling back to last trade — matches Polymarket order book display. */
export function quoteToPrice(quote: TokenQuote): number | null {
  if (quote.bestBid != null && quote.bestAsk != null) {
    return (quote.bestBid + quote.bestAsk) / 2
  }
  if (quote.lastTrade != null) return quote.lastTrade
  if (quote.bestAsk != null) return quote.bestAsk
  if (quote.bestBid != null) return quote.bestBid
  return null
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

function patchQuote(map: QuoteMap, assetId: string, patch: Partial<TokenQuote>) {
  const prev = map[assetId] ?? emptyQuote()
  map[assetId] = { ...prev, ...patch }
}

function buildUpdate(
  map: QuoteMap,
  upTokenId: string,
  downTokenId: string,
): LiveQuoteUpdate {
  const up = map[upTokenId] ?? emptyQuote()
  const down = map[downTokenId] ?? emptyQuote()

  return {
    upPrice: quoteToPrice(up),
    downPrice: quoteToPrice(down),
    bestBidUp: up.bestBid,
    bestAskUp: up.bestAsk,
    bestBidDown: down.bestBid,
    bestAskDown: down.bestAsk,
  }
}

interface BookMessage {
  event_type?: string
  asset_id?: string
  bids?: Array<{ price: string }>
  asks?: Array<{ price: string }>
}

interface PriceChangeItem {
  asset_id: string
  best_bid?: string
  best_ask?: string
}

interface PriceChangeMessage {
  event_type?: string
  price_changes?: PriceChangeItem[]
}

interface BestBidAskMessage {
  event_type?: string
  asset_id?: string
  best_bid?: string
  best_ask?: string
}

interface LastTradeMessage {
  event_type?: string
  asset_id?: string
  price?: string
}

function handleQuotePatches(raw: unknown, map: QuoteMap, onChanged: () => void): void {
  const apply = () => onChanged()

  if (Array.isArray(raw)) {
    for (const item of raw) {
      handleQuotePatches(item, map, onChanged)
    }
    return
  }

  if (!raw || typeof raw !== 'object') return

  const msg = raw as Record<string, unknown>
  const eventType = msg.event_type as string | undefined

  if (eventType === 'book') {
    const book = msg as BookMessage
    if (!book.asset_id) return
    const { bestBid, bestAsk } = bestFromBook(book.bids ?? [], book.asks ?? [])
    patchQuote(map, book.asset_id, { bestBid, bestAsk })
    apply()
    return
  }

  if (eventType === 'price_change') {
    const change = msg as PriceChangeMessage
    for (const item of change.price_changes ?? []) {
      patchQuote(map, item.asset_id, {
        bestBid: toNum(item.best_bid),
        bestAsk: toNum(item.best_ask),
      })
    }
    apply()
    return
  }

  if (eventType === 'best_bid_ask') {
    const bidAsk = msg as BestBidAskMessage
    if (!bidAsk.asset_id) return
    patchQuote(map, bidAsk.asset_id, {
      bestBid: toNum(bidAsk.best_bid),
      bestAsk: toNum(bidAsk.best_ask),
    })
    apply()
    return
  }

  if (eventType === 'last_trade_price') {
    const trade = msg as LastTradeMessage
    if (!trade.asset_id) return
    patchQuote(map, trade.asset_id, { lastTrade: toNum(trade.price) })
    apply()
  }
}

function handleMessage(
  raw: unknown,
  map: QuoteMap,
  upTokenId: string,
  downTokenId: string,
  onUpdate: (update: LiveQuoteUpdate) => void,
): void {
  handleQuotePatches(raw, map, () => onUpdate(buildUpdate(map, upTokenId, downTokenId)))
}

export type TokenQuoteMap = Record<string, TokenQuote>

export interface TokenQuotesStreamOptions {
  tokenIds: string[]
  onUpdate: (quotes: TokenQuoteMap) => void
  onConnectedChange?: (connected: boolean) => void
}

function snapshotQuotes(map: QuoteMap, tokenIds: string[]): TokenQuoteMap {
  const out: TokenQuoteMap = {}
  for (const id of tokenIds) {
    out[id] = map[id] ?? emptyQuote()
  }
  return out
}

/** Subscribe to live quotes for an arbitrary set of outcome tokens (e.g. portfolio positions). */
export function subscribeTokenQuotes({
  tokenIds,
  onUpdate,
  onConnectedChange,
}: TokenQuotesStreamOptions): () => void {
  const assetIds = [...new Set(tokenIds.filter(Boolean))]
  if (!assetIds.length) return () => {}

  const quotes: QuoteMap = {}
  let ws: WebSocket | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const clearTimers = () => {
    if (pingTimer) clearInterval(pingTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    pingTimer = null
    reconnectTimer = null
  }

  const connect = () => {
    if (closed) return

    ws = new WebSocket(WS_URL)

    ws.onopen = () => {
      onConnectedChange?.(true)
      ws?.send(
        JSON.stringify({
          assets_ids: assetIds,
          type: 'market',
          custom_feature_enabled: true,
        }),
      )
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send('PING')
      }, PING_MS)
    }

    ws.onmessage = (event) => {
      if (event.data === 'PONG') return
      try {
        handleQuotePatches(JSON.parse(event.data as string), quotes, () => {
          onUpdate(snapshotQuotes(quotes, assetIds))
        })
      } catch {
        // ignore malformed frames
      }
    }

    ws.onclose = () => {
      onConnectedChange?.(false)
      clearTimers()
      ws = null
      if (!closed) {
        reconnectTimer = setTimeout(connect, RECONNECT_MS)
      }
    }

    ws.onerror = () => {
      ws?.close()
    }
  }

  connect()

  return () => {
    closed = true
    clearTimers()
    ws?.close()
    ws = null
    onConnectedChange?.(false)
  }
}

export interface MarketStreamOptions {
  upTokenId: string
  downTokenId: string
  onUpdate: (update: LiveQuoteUpdate) => void
  onConnectedChange: (connected: boolean) => void
}

/** Subscribe to Polymarket CLOB market channel for instant bid/ask/trade updates. */
export function subscribeMarketStream({
  upTokenId,
  downTokenId,
  onUpdate,
  onConnectedChange,
}: MarketStreamOptions): () => void {
  const assetIds = [upTokenId, downTokenId]
  const quotes: QuoteMap = {}
  let ws: WebSocket | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const clearTimers = () => {
    if (pingTimer) clearInterval(pingTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    pingTimer = null
    reconnectTimer = null
  }

  const connect = () => {
    if (closed) return

    ws = new WebSocket(WS_URL)

    ws.onopen = () => {
      onConnectedChange(true)
      ws?.send(
        JSON.stringify({
          assets_ids: assetIds,
          type: 'market',
          custom_feature_enabled: true,
        }),
      )
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send('PING')
      }, PING_MS)
    }

    ws.onmessage = (event) => {
      if (event.data === 'PONG') return
      try {
        handleMessage(JSON.parse(event.data as string), quotes, upTokenId, downTokenId, onUpdate)
      } catch {
        // ignore malformed frames
      }
    }

    ws.onclose = () => {
      onConnectedChange(false)
      clearTimers()
      ws = null
      if (!closed) {
        reconnectTimer = setTimeout(connect, RECONNECT_MS)
      }
    }

    ws.onerror = () => {
      ws?.close()
    }
  }

  connect()

  return () => {
    closed = true
    clearTimers()
    ws?.close()
    ws = null
    onConnectedChange(false)
  }
}
