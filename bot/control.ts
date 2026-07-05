/**
 * Local control server for the dashboard's Dry/Live switch. Binds 127.0.0.1
 * only; CORS reflects localhost origins; mutating POSTs require x-bot-token when
 * BOT_CONTROL_TOKEN is set (recommended — a custom header forces a preflight a
 * hostile page can't satisfy). GET /status is read-only/open.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'

export type BotMode = 'record' | 'dry' | 'live'

export interface BotStatus {
  mode: BotMode
  /** Active entry/exit family — fixed at launch via BOT_STRATEGY (not runtime-switchable). */
  strategy: 'value' | 'swing'
  allowLive: boolean
  halted: boolean
  connected: boolean
  scopes: string[]
  liveScopes: number
  stats: { ticks: number; predictions: number; outcomes: number; trades: number; settled: number }
  summary: { entered: number; settled: number; open: number; wins: number; staked: number; pnl: number }
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
}

export interface BotRuntime {
  getStatus(): BotStatus
  setMode(mode: BotMode): Promise<{ ok: boolean; error?: string }>
  setHalted(halted: boolean): void
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
