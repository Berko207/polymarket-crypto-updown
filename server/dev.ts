/**
 * Local dev: Vite (browser) + API routes on one machine, credentials from .env.local.
 * Run `pnpm dev` — no Vercel CLI required.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import '../api/_lib/loadEnv.js'
import { invokeHandler } from './vercel-adapter.js'
import account from '../api/account.js'
import authConfig from '../api/auth-config.js'
import gamma from '../api/gamma/[...path].js'
import openOrders from '../api/open-orders.js'
import orders from '../api/orders.js'
import positions from '../api/positions.js'
import tradeHistory from '../api/trade-history.js'
import warm from '../api/warm.js'
import cryptoPrice from '../api/crypto-price.js'
import cryptoPriceHistory from '../api/crypto-price-history.js'

const API_PORT = Number(process.env.API_PORT || 8787)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

type Route = { test: (pathname: string) => boolean; handler: Parameters<typeof invokeHandler>[0] }

const routes: Route[] = [
  { test: (p) => p === '/api/auth-config', handler: authConfig },
  { test: (p) => p === '/api/account', handler: account },
  { test: (p) => p === '/api/orders', handler: orders },
  { test: (p) => p === '/api/open-orders', handler: openOrders },
  { test: (p) => p === '/api/positions', handler: positions },
  { test: (p) => p === '/api/trade-history', handler: tradeHistory },
  { test: (p) => p === '/api/warm', handler: warm },
  { test: (p) => p === '/api/crypto-price', handler: cryptoPrice },
  { test: (p) => p === '/api/crypto-price-history', handler: cryptoPriceHistory },
  { test: (p) => p.startsWith('/api/gamma/'), handler: gamma },
]

function findRoute(pathname: string): Route | undefined {
  return routes.find((r) => r.test(pathname))
}

const server = createServer(async (req, res) => {
  if (!req.url) {
    res.statusCode = 400
    res.end('Bad request')
    return
  }

  const url = new URL(req.url, `http://127.0.0.1:${API_PORT}`)
  const route = findRoute(url.pathname)

  if (!route) {
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'Not found' }))
    return
  }

  try {
    await invokeHandler(route.handler, req, res, url)
    if (!res.writableEnded) {
      res.statusCode = 500
      res.end('Handler did not send a response')
    }
  } catch (error) {
    if (!res.writableEnded) {
      const message = error instanceof Error ? error.message : 'Internal server error'
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: message }))
    }
  }
})

let vite: ChildProcess | null = null
let bot: ChildProcess | null = null

function shutdown(code = 0) {
  bot?.kill('SIGTERM')
  vite?.kill('SIGTERM')
  server.close(() => process.exit(code))
}

const BOT_CONTROL_PORT = Number(process.env.BOT_CONTROL_PORT || 8790)

async function botControlReachable(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${BOT_CONTROL_PORT}/status`, {
      signal: AbortSignal.timeout(800),
    })
    return res.ok
  } catch {
    return false
  }
}

server.listen(API_PORT, () => {
  console.log(`[dev] API listening on http://127.0.0.1:${API_PORT} (.env.local loaded)`)

  void (async () => {
    // Paper bot for the dashboard — Live stays disabled (BOT_ALLOW_LIVE=0).
    // Skip if something already owns :8790 (e.g. `pnpm bot:live` in another terminal).
    // Or set DEV_NO_BOT=1 to never auto-start a bot.
    if (process.env.DEV_NO_BOT === '1') {
      console.log('[dev] DEV_NO_BOT=1 — bot not started (run pnpm bot:paper or pnpm bot:live)')
    } else if (await botControlReachable()) {
      console.log(
        `[dev] bot control already on :${BOT_CONTROL_PORT} — not starting paper bot ` +
          '(use that instance; Live works if it was started with pnpm bot:live)',
      )
    } else {
      bot = spawn('pnpm', ['exec', 'tsx', 'bot/index.ts', 'paper'], {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, BOT_ALLOW_LIVE: '0' },
      })
      bot.on('exit', (code) => {
        if (code != null && code !== 0) console.error(`[dev] bot exited ${code}`)
      })
    }
  })()

  vite = spawn('pnpm', ['exec', 'vite'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, VITE_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
  })

  vite.on('exit', (code) => shutdown(code ?? 0))
})

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
