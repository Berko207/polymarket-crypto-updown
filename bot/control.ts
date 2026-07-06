/**
 * Local control server for the dashboard's Dry/Live switch. Binds 127.0.0.1
 * only; CORS reflects localhost origins; mutating POSTs require x-bot-token when
 * BOT_CONTROL_TOKEN is set (recommended — a custom header forces a preflight a
 * hostile page can't satisfy). GET /status is read-only/open.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { TradeQuery, TradeHistoryPage } from './db'

export type BotMode = 'record' | 'dry' | 'live'

export interface BotStatus {
  mode: BotMode
  /** USDC stake per automated entry (runtime-adjustable via POST /stake). */
  stakeUsd: number
  /** CLOB USDC balance when live (null in record/dry or before first arm). */
  usdcBalance: number | null
  /** Active entry/exit family — runtime-switchable from the dashboard (POST /strategy). */
  strategy: 'value' | 'swing' | 'maker'
  allowLive: boolean
  halted: boolean
  connected: boolean
  scopes: string[]
  liveScopes: number
  stats: { ticks: number; predictions: number; outcomes: number; trades: number; settled: number }
  summary: { entered: number; settled: number; open: number; wins: number; staked: number; pnl: number }
  /** Entries in the rolling 24h window vs the cap — when equal, new entries are blocked. */
  dailyTrades: number
  maxDailyTrades: number
  /** Timeframes entries currently fire on (a subset of availableTimeframes). */
  tradeTimeframes: string[]
  /** Every recorded timeframe — the toggleable universe for trade selection. */
  availableTimeframes: string[]
  /** Open positions still being force-closed at market after a strategy switch. */
  pendingCloses: number
  /** Closed swing trades by exit reason (empty for the value strategy). */
  swingExits: { reason: string; n: number; wins: number; pnl: number }[]
  /** Active swing entry trigger + fair-value source (swing strategy only). */
  swingTrigger: 'edge' | 'move'
  swingSource: 'flat' | 'regime' | 'blend'
  /** Currently-open positions with live mark, unrealized P&L, and time left. */
  openPositions: {
    coin: string
    timeframe: string
    side: 'up' | 'down'
    strategy: string
    entryPrice: number
    size: number
    mark: number | null
    unrealizedPnl: number | null
    msRemaining: number | null
  }[]
  /** Most-recent finished trades, newest first (activity feed). */
  recentClosed: {
    mode: string
    coin: string
    timeframe: string
    side: 'up' | 'down'
    strategy: string
    entryPrice: number
    exitPrice: number | null
    exitReason: string | null
    pnl: number
    settleT: number
    status: string
  }[]
  /** Maker-strategy live state — present only while strategy='maker'. */
  maker?: {
    fillModel: 'L1' | 'L2'
    baseSpread: number
    clipUsd: number
    maxInventory: number
    rebateRate: number
    /** CLOB depth/tape feed connected. */
    feedConnected: boolean
    /** Simulated fills booked this session. */
    fills: number
    /** Resting quotes currently on the (simulated) book. */
    openQuotes: number
    /** Net inventory per open window. */
    inventory: { coin: string; timeframe: string; net: number; upShares: number; downShares: number }[]
    /** The resting quotes themselves (remaining size). */
    quotes: { coin: string; timeframe: string; side: 'up' | 'down'; price: number; size: number }[]
  }
}

export interface BotRuntime {
  getStatus(): BotStatus
  setMode(mode: BotMode): Promise<{ ok: boolean; error?: string }>
  setHalted(halted: boolean): void
  setStakeUsd(stakeUsd: number): { ok: boolean; error?: string }
  /** 0 = mode default (50 live, unlimited paper). */
  setMaxDailyTrades(maxDailyTrades: number): { ok: boolean; error?: string }
  setStrategy(strategy: 'value' | 'swing' | 'maker'): { ok: boolean; error?: string }
  setTradeTimeframes(timeframes: string[]): { ok: boolean; error?: string }
  /** Runtime maker tuning — any subset of the knobs. */
  setMaker(patch: {
    baseSpread?: number
    clipUsd?: number
    maxInventory?: number
    fillModel?: 'L1' | 'L2'
    rebateRate?: number
  }): { ok: boolean; error?: string }
  getHistory(query: TradeQuery): TradeHistoryPage
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function startControlServer(
  runtime: BotRuntime,
  port: number,
  token: string | undefined,
  log: (...args: unknown[]) => void,
): Server {
  const server = createServer((req, res) => {
    const origin = req.headers.origin
    if (origin && LOCAL_ORIGIN.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-bot-token')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    }
    const send = (code: number, body: unknown): void => {
      res.statusCode = code
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

    void (async () => {
      try {
        if (req.method === 'GET' && url.pathname === '/status') return send(200, runtime.getStatus())

        if (req.method === 'GET' && url.pathname === '/history') {
          const p = url.searchParams
          const str = (k: string): string | undefined => {
            const v = p.get(k)
            return v && v !== 'all' ? v : undefined
          }
          const int = (k: string): number | undefined => {
            const v = p.get(k)
            if (v == null || v === '') return undefined
            const n = Number(v)
            return Number.isFinite(n) ? n : undefined
          }
          const outcome = str('outcome')
          return send(
            200,
            runtime.getHistory({
              mode: str('mode'),
              strategy: str('strategy'),
              coin: str('coin'),
              timeframe: str('timeframe'),
              status: str('status'),
              reason: str('reason'),
              outcome: outcome === 'win' || outcome === 'loss' ? outcome : undefined,
              from: int('from'),
              to: int('to'),
              limit: int('limit'),
              offset: int('offset'),
            }),
          )
        }

        if (req.method === 'POST') {
          if (token && req.headers['x-bot-token'] !== token) {
            return send(401, { error: 'missing or bad x-bot-token' })
          }
          const body = await readJson(req)
          if (url.pathname === '/mode') {
            // 'paper' is the UI's name for the wire mode 'dry' — accept it here too.
            const mode = body.mode === 'paper' ? 'dry' : body.mode
            if (mode !== 'record' && mode !== 'dry' && mode !== 'live') {
              return send(400, { error: 'mode must be record|dry (alias: paper)|live' })
            }
            const r = await runtime.setMode(mode)
            return r.ok ? send(200, runtime.getStatus()) : send(409, { error: r.error })
          }
          if (url.pathname === '/halt') {
            runtime.setHalted(Boolean(body.halted))
            return send(200, runtime.getStatus())
          }
          if (url.pathname === '/stake') {
            const stakeUsd = Number(body.stakeUsd)
            const r = runtime.setStakeUsd(stakeUsd)
            return r.ok ? send(200, runtime.getStatus()) : send(400, { error: r.error })
          }
          if (url.pathname === '/daily-cap') {
            const maxDailyTrades = Number(body.maxDailyTrades)
            const r = runtime.setMaxDailyTrades(maxDailyTrades)
            return r.ok ? send(200, runtime.getStatus()) : send(400, { error: r.error })
          }
          if (url.pathname === '/strategy') {
            const strategy = body.strategy
            if (strategy !== 'value' && strategy !== 'swing' && strategy !== 'maker') {
              return send(400, { error: 'strategy must be value|swing|maker' })
            }
            const r = runtime.setStrategy(strategy)
            return r.ok ? send(200, runtime.getStatus()) : send(400, { error: r.error })
          }
          if (url.pathname === '/timeframes') {
            if (!Array.isArray(body.timeframes)) {
              return send(400, { error: 'timeframes must be an array' })
            }
            const r = runtime.setTradeTimeframes(body.timeframes.map(String))
            return r.ok ? send(200, runtime.getStatus()) : send(400, { error: r.error })
          }
          if (url.pathname === '/maker') {
            const num = (v: unknown): number | undefined => {
              if (v == null || v === '') return undefined
              const n = Number(v)
              return Number.isFinite(n) ? n : undefined
            }
            const patch: Parameters<BotRuntime['setMaker']>[0] = {}
            const bs = num(body.baseSpread)
            if (bs != null) patch.baseSpread = bs
            const cl = num(body.clipUsd)
            if (cl != null) patch.clipUsd = cl
            const mi = num(body.maxInventory)
            if (mi != null) patch.maxInventory = mi
            const rb = num(body.rebateRate)
            if (rb != null) patch.rebateRate = rb
            if (body.fillModel === 'L1' || body.fillModel === 'L2') patch.fillModel = body.fillModel
            const r = runtime.setMaker(patch)
            return r.ok ? send(200, runtime.getStatus()) : send(400, { error: r.error })
          }
        }
        send(404, { error: 'not found' })
      } catch (e) {
        send(500, { error: e instanceof Error ? e.message : 'control error' })
      }
    })()
  })

  server.listen(port, '127.0.0.1', () =>
    log(`control server on http://127.0.0.1:${port}${token ? ' (token required)' : ' (no token — set BOT_CONTROL_TOKEN)'}`),
  )
  return server
}
