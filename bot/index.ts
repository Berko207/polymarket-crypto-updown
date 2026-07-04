/**
 * M1 recorder: headless, 24/7. Streams Chainlink ticks + gamma odds for every
 * in-scope market, logs flat+regime predictions (throttled) and window outcomes
 * to SQLite. No trading. `pnpm bot:record`.
 */
import { activeScopes, loadConfig } from './config'
import { openDb } from './db'
import { ChainlinkStream } from './sources/chainlink'
import { fetchCurrentMarket } from './sources/gamma'
import { predict, type Prediction } from './engine/predict'
import { decideEntry } from './engine/strategy'
import { dryExecutor } from './engine/executor'
import { VOL_LOOKBACK_MS } from '../src/lib/fairValue'
import { chainlinkPair } from '../src/lib/cryptoPrice'
import type { CoinId, ParsedMarket, TimeframeId } from '../src/lib/types'

interface ScopeState {
  coin: CoinId
  timeframe: TimeframeId
  pair: string
  market: ParsedMarket | null
  lastFetch: number
  fetching: boolean
}

interface TrackedWindow {
  pair: string
  coin: string
  timeframe: string
  strike: number
  endMs: number
}

const STATUS_MS = 30_000
const OUTCOME_SLOP_MS = 120_000
const OUTCOME_GIVEUP_MS = 150_000

function log(...args: unknown[]): void {
  console.info(new Date().toISOString(), ...args)
}

async function main(): Promise<void> {
  const config = loadConfig()
  const mode: 'record' | 'dry' = process.argv[2] === 'dry' ? 'dry' : 'record'
  const db = openDb(config.dbPath)
  const stream = new ChainlinkStream()

  const stats = { ticks: 0, predictions: 0, outcomes: 0, trades: 0, settled: 0 }
  /** Windows we've already entered this session — sync guard against the async
   * entry double-firing across ticks (DB tradeExists guards across restarts). */
  const entered = new Set<string>()
  stream.start((symbol, tick) => {
    db.insertTick({ symbol, ts: tick.timestamp, value: tick.value, carried: tick.carried ? 1 : 0 })
    stats.ticks += 1
  })

  const scopes: ScopeState[] = activeScopes(config)
    .map(({ coin, timeframe }): ScopeState | null => {
      const pair = chainlinkPair(coin)
      return pair ? { coin, timeframe, pair, market: null, lastFetch: 0, fetching: false } : null
    })
    .filter((s): s is ScopeState => s != null)

  const lastSample = new Map<string, number>()
  const tracked = new Map<string, TrackedWindow>()

  log(
    `${mode} up · db=${config.dbPath} · scopes=${scopes.map((s) => `${s.coin}/${s.timeframe}`).join(',')}` +
      (mode === 'dry'
        ? ` · entry ~T-${config.entryAtSec}s · edge≥${config.edgeThreshold} · $${config.stakeUsd}`
        : ''),
  )

  // Dry paper entry: once per window, late (~T-10s), on a confident non-panic edge.
  async function maybeTrade(pred: Prediction, market: ParsedMarket, now: number): Promise<void> {
    if (entered.has(pred.windowKey) || db.tradeExists(pred.windowKey)) return
    if (db.countOpenTrades() >= config.maxConcurrent) return
    if (db.countTradesSince(now - 86_400_000) >= config.maxDailyTrades) return
    const order = decideEntry(pred, market, config, now)
    if (!order) return
    entered.add(pred.windowKey) // claim before the await so the next tick can't double-enter
    const fill = await dryExecutor.buy(order)
    db.insertTrade({
      windowKey: pred.windowKey,
      coin: pred.coin,
      timeframe: pred.timeframe,
      mode: 'dry',
      side: order.side,
      entryT: now,
      entryPrice: fill.fillPrice,
      size: fill.fillSize,
      cost: order.stakeUsd,
      signalEdge: pred.edge,
      regimeEntry: pred.regime,
      status: 'open',
      orderId: fill.orderId,
    })
    stats.trades += 1
    log(
      `DRY ENTER ${pred.coin}/${pred.timeframe} ${order.side} @ ${fill.fillPrice.toFixed(3)} · ` +
        `size ${fill.fillSize.toFixed(1)} · edge ${pred.edge.toFixed(3)} · ${pred.regime} · ` +
        `${Math.round((market.endDate.getTime() - now) / 1000)}s left`,
    )
  }

  function settleTrades(now: number): void {
    for (const s of db.pendingSettlements()) {
      const won = s.side === s.outcome
      const payout = won ? s.size : 0
      const pnl = payout - s.cost
      db.settleTrade(s.id, now, payout, pnl)
      stats.settled += 1
      log(`DRY SETTLE ${s.side} ${won ? 'WIN ' : 'loss'} · pnl ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)}`)
    }
  }

  function refreshMarket(state: ScopeState, now: number): void {
    const ended = state.market ? now >= state.market.endDate.getTime() : true
    if (state.fetching) return
    if (state.market && !ended && now - state.lastFetch < config.marketPollMs) return
    state.fetching = true
    void fetchCurrentMarket(state.coin, state.timeframe)
      .then((m) => {
        state.market = m
        state.lastFetch = Date.now()
      })
      .catch(() => {})
      .finally(() => {
        state.fetching = false
      })
  }

  function sampleScope(state: ScopeState, now: number): void {
    const market = state.market
    if (!market || now >= market.endDate.getTime()) return

    const windowStart = market.startDate?.getTime()
    // Prefer the observed Chainlink open; fall back to gamma's strike when the
    // bot started mid-window (no pre-open tick in the ring buffer).
    let strike =
      windowStart != null ? stream.firstPriceAtOrAfter(state.pair, windowStart, 90_000) : null
    if (strike == null) strike = market.priceToBeat
    const spot = stream.latest(state.pair)?.value ?? null
    if (strike == null || spot == null) return

    const ticks = stream.ticksSince(state.pair, now - VOL_LOOKBACK_MS[market.timeframe])
    const pred = predict(market, ticks, strike, spot, now)
    if (!pred) return

    // Track for outcome recording regardless of the sample throttle.
    if (!tracked.has(pred.windowKey)) {
      tracked.set(pred.windowKey, {
        pair: state.pair,
        coin: pred.coin,
        timeframe: pred.timeframe,
        strike,
        endMs: market.endDate.getTime(),
      })
    }

    // Trade every tick (not throttled) so the late T-10s entry lands on time.
    if (mode === 'dry') void maybeTrade(pred, market, now)

    if (now - (lastSample.get(pred.windowKey) ?? 0) < config.sampleMs) return
    lastSample.set(pred.windowKey, now)
    db.insertPrediction({
      windowKey: pred.windowKey,
      coin: pred.coin,
      timeframe: pred.timeframe,
      t: pred.t,
      msRemaining: pred.msRemaining,
      spot: pred.spot,
      strike: pred.strike,
      modelP: pred.modelP,
      regimeP: pred.regimeP,
      regime: pred.regime,
      regimeRatio: pred.regimeRatio,
      marketP: pred.marketP,
      upBid: pred.upBid,
      upAsk: pred.upAsk,
      sigmaWindow: pred.sigmaWindow,
      confidence: pred.confidence,
    })
    stats.predictions += 1
  }

  function sweepOutcomes(now: number): void {
    for (const [windowKey, w] of tracked) {
      if (now <= w.endMs + 2_000) continue
      if (db.hasOutcome(windowKey)) {
        tracked.delete(windowKey)
        continue
      }
      const finalPrice = stream.firstPriceAtOrAfter(w.pair, w.endMs, OUTCOME_SLOP_MS)
      if (finalPrice != null) {
        db.upsertOutcome({
          windowKey,
          coin: w.coin,
          timeframe: w.timeframe,
          strike: w.strike,
          finalPrice,
          outcome: finalPrice > w.strike ? 'up' : 'down',
          endMs: w.endMs,
          recordedAt: now,
        })
        stats.outcomes += 1
        tracked.delete(windowKey)
      } else if (now > w.endMs + OUTCOME_GIVEUP_MS) {
        tracked.delete(windowKey) // boundary tick never arrived
      }
    }
  }

  let lastStatus = 0
  const timer = setInterval(() => {
    const now = Date.now()
    for (const state of scopes) {
      refreshMarket(state, now)
      sampleScope(state, now)
    }
    sweepOutcomes(now)
    if (mode === 'dry') settleTrades(now)

    if (now - lastStatus >= STATUS_MS) {
      lastStatus = now
      const live = scopes.filter((s) => s.market).length
      log(
        `ws=${stream.connected ? 'up' : 'down'} · live=${live}/${scopes.length} · ` +
          `ticks=${stats.ticks} preds=${stats.predictions} outcomes=${stats.outcomes}` +
          (mode === 'dry'
            ? ` · trades=${stats.trades} settled=${stats.settled} open=${db.countOpenTrades()}`
            : '') +
          ` · pending=${tracked.size}`,
      )
    }
  }, config.tickMs)

  const shutdown = (): void => {
    clearInterval(timer)
    stream.stop()
    db.close()
    log('recorder stopped')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main()
