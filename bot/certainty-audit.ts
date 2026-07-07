/**
 * One-shot audit: which scopes pass Easy gates right now?
 * Usage: tsx bot/certainty-audit.ts
 */
import '../api/_lib/loadEnv'
import { loadConfig } from './config'
import { loadRuntimeSettings } from './runtime'
import { resolve } from 'node:path'
import { activeScopes } from './config'
import { ChainlinkStream } from './sources/chainlink'
import { fetchCurrentMarket } from './sources/gamma'
import { predict } from './engine/predict'
import { evaluateCertainty, inCertaintyEntryBand, certaintyBlockReason, certaintyStrike } from './engine/certainty'
import { fetchClobBestAsk } from './sources/clobBook'
import { chainlinkPair } from '../src/lib/cryptoPrice'
import { VOL_LOOKBACK_MS } from '../src/lib/fairValue'

const RUNTIME_PATH = resolve(process.cwd(), 'bot/runtime.json')

async function main(): Promise<void> {
  const useClobAsk = process.argv.includes('--clob')
  const config = loadConfig()
  const runtime = loadRuntimeSettings(RUNTIME_PATH)
  if (runtime.certainty) {
    const rc = runtime.certainty
    if (rc.entryWithinSec != null) config.certaintyEntryWithinSec = rc.entryWithinSec
    if (rc.minWinProb != null) config.certaintyMinWinProb = rc.minWinProb
    if (rc.minEdge != null) config.certaintyMinEdge = rc.minEdge
    if (rc.maxAsk != null) config.certaintyMaxAsk = rc.maxAsk
    if (rc.maxCoins != null) config.certaintyMaxCoins = rc.maxCoins
  }
  if (runtime.maxDailyTrades != null) config.maxDailyTrades = runtime.maxDailyTrades

  const stream = new ChainlinkStream()
  stream.start()
  await new Promise((r) => setTimeout(r, 3000))

  const now = Date.now()
  const scopes = activeScopes(config)
  const tradeTf = new Set(config.tradeTimeframes)
  let inBand = 0
  let ok = 0

  console.log(
    `Config: T-${config.certaintyEntryWithinSec}s · P≥${config.certaintyMinWinProb} · edge≥${config.certaintyMinEdge} · ask≤${config.certaintyMaxAsk} · z≥${config.certaintyMinZ} · maxCoins ${config.certaintyMaxCoins}${useClobAsk ? ' · CLOB ask' : ''}`,
  )
  console.log(`Trade TFs: ${[...tradeTf].join(',')}\n`)

  for (const { coin, timeframe } of scopes) {
    const pair = chainlinkPair(coin)
    if (!pair) continue
    const market = await fetchCurrentMarket(coin, timeframe)
    if (!market) {
      console.log(`${coin}/${timeframe}: no live market`)
      continue
    }
    const msRemaining = market.endDate.getTime() - now
    if (!inCertaintyEntryBand(msRemaining, config)) {
      console.log(
        `${coin}/${timeframe}: outside T-band (${(msRemaining / 1000).toFixed(0)}s left)`,
      )
      continue
    }
    inBand++
    if (!tradeTf.has(timeframe)) {
      console.log(`${coin}/${timeframe}: in T-band but timeframe not traded`)
      continue
    }

    const windowStart = market.startDate?.getTime()
    let strike =
      windowStart != null ? stream.firstPriceAtOrAfter(pair, windowStart, 90_000) : null
    strike = certaintyStrike(market, strike)
    const spot = stream.latest(pair)?.value ?? null
    if (strike == null || spot == null) {
      console.log(`${coin}/${timeframe}: missing spot/strike (spot=${spot} strike=${strike})`)
      continue
    }

    const ticks = stream.ticksSince(pair, now - VOL_LOOKBACK_MS[market.timeframe])
    const pred = predict(market, ticks, strike, spot, now)
    if (!pred) {
      console.log(`${coin}/${timeframe}: predict() null`)
      continue
    }

    const side = spot >= strike ? 'up' : 'down'
    let evalOpts: { clobAsk?: number | null; clobOppAsk?: number | null; requireClobAsk?: boolean } | undefined
    if (useClobAsk) {
      const favoredId = side === 'up' ? market.upTokenId : market.downTokenId
      const oppId = side === 'up' ? market.downTokenId : market.upTokenId
      const [clobAsk, clobOppAsk] = await Promise.all([
        favoredId ? fetchClobBestAsk(favoredId) : Promise.resolve(null),
        oppId ? fetchClobBestAsk(oppId) : Promise.resolve(null),
      ])
      evalOpts = { clobAsk, clobOppAsk, requireClobAsk: true }
    }

    const ev = evaluateCertainty(pred, market, spot, strike, config, now, evalOpts)
    const block = ev.ok ? null : certaintyBlockReason(pred, market, spot, strike, config, now, evalOpts)
    if (ev.ok) {
      ok++
      console.log(
        `✓ ${coin}/${timeframe} ${ev.side} · P=${ev.pWin.toFixed(3)} edge=${ev.edge.toFixed(3)} ask=${ev.ask.toFixed(3)} z=${ev.zDist.toFixed(2)} score=${ev.score.toFixed(3)} · ${(msRemaining / 1000).toFixed(0)}s`,
      )
    } else {
      console.log(
        `✗ ${coin}/${timeframe} · ${block ?? ev.reason} · P=${ev.pWin.toFixed(3)} edge=${ev.edge.toFixed(3)} ask=${ev.ask.toFixed(3)} z=${ev.zDist.toFixed(2)} · ${(msRemaining / 1000).toFixed(0)}s`,
      )
    }
  }

  console.log(`\nIn T-band: ${inBand} · Would trade: ${ok}`)
  stream.stop()
  process.exit(0)
}

void main()
