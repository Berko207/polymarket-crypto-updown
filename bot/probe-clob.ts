/**
 * Phase-0 verification harness for the maker feed (docs/maker-paper-strategy.md).
 * Streams the live CLOB order book + trade tape for the bot's tradable tokens and
 * logs top-of-book, ladder depth, and recent trade counts — so you can eyeball the
 * feed against the dashboard order book BEFORE any maker logic is built. Log-only,
 * no trading, no DB. Rolls the token set as windows expire.
 *
 *   pnpm bot:probe-book
 */
import '../api/_lib/loadEnv'
import { loadConfig, activeScopes } from './config'
import { fetchCurrentMarket } from './sources/gamma'
import { ClobMarketStream } from './sources/clobMarket'

const LOG_MS = 5_000
const MARKET_REFRESH_MS = 60_000

function log(...args: unknown[]): void {
  console.info(new Date().toISOString(), ...args)
}

async function main(): Promise<void> {
  const config = loadConfig()
  const scopes = activeScopes(config)
  const stream = new ClobMarketStream()
  let tradesThisRun = 0
  stream.start(() => {
    tradesThisRun += 1
  })

  // tokenId → "coin/tf UP" label, rebuilt each market refresh.
  const labels = new Map<string, string>()

  async function refreshMarkets(): Promise<void> {
    const markets = await Promise.all(
      scopes.map((s) => fetchCurrentMarket(s.coin, s.timeframe).catch(() => null)),
    )
    labels.clear()
    const ids: string[] = []
    markets.forEach((m, i) => {
      if (!m) return
      const { coin, timeframe } = scopes[i]
      if (m.upTokenId) {
        ids.push(m.upTokenId)
        labels.set(m.upTokenId, `${coin}/${timeframe} UP`)
      }
      if (m.downTokenId) {
        ids.push(m.downTokenId)
        labels.set(m.downTokenId, `${coin}/${timeframe} DN`)
      }
    })
    stream.setTokens(ids)
    log(`tracking ${ids.length} tokens across ${markets.filter(Boolean).length}/${scopes.length} live windows`)
  }

  await refreshMarkets()
  const refreshTimer = setInterval(() => void refreshMarkets().catch((e) => log('refresh error', e)), MARKET_REFRESH_MS)

  const px = (n: number | null): string => (n != null ? n.toFixed(3) : ' -- ')
  const logTimer = setInterval(() => {
    const now = Date.now()
    const s = stream.stats()
    log(
      `ws=${s.connected ? 'up' : 'down'} · tokens=${s.tokens} withBook=${s.withBook} ` +
        `tapePrints=${s.totalPrints} tradesThisRun=${tradesThisRun}`,
    )
    for (const [id, label] of labels) {
      const { bid, ask } = stream.bestBidAsk(id)
      const book = stream.book(id)
      const recent = stream.tradesSince(id, now - LOG_MS).length
      log(
        `  ${label.padEnd(14)} bid ${px(bid)} / ask ${px(ask)} · ` +
          `levels ${book?.bids.length ?? 0}×${book?.asks.length ?? 0} · trades/${LOG_MS / 1000}s ${recent}`,
      )
    }
  }, LOG_MS)

  const shutdown = (): void => {
    clearInterval(refreshTimer)
    clearInterval(logTimer)
    stream.stop()
    log('probe stopped')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main()
