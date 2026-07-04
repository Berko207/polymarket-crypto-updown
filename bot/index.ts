/**
 * Bot entry. Streams Chainlink ticks + gamma odds for every in-scope market,
 * logs flat+regime predictions and outcomes to SQLite, and (dry/live) trades the
 * late T-10s edge signal. Mode is runtime-switchable via the control server so
 * the dashboard can flip Dry/Live without a restart.
 *   record → log only · dry → paper-trade · live → real FAK orders (gated)
 */
import '../api/_lib/loadEnv' // side effect: load .env.local (POLY_* for live, BOT_* overrides)
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { activeScopes, loadConfig } from './config'
import { openDb } from './db'
import { ChainlinkStream } from './sources/chainlink'
import { fetchCurrentMarket } from './sources/gamma'
import { predict, type Prediction } from './engine/predict'
import { decideEntry } from './engine/strategy'
import { dryExecutor, makeLiveExecutor } from './engine/executor'
import { maxOrderCost, tradingEnabled } from './engine/guards'
import { startControlServer, type BotMode } from './control'
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
  // Mutable at runtime so the dashboard can flip the switch without a restart.
  let mode: BotMode =
    process.argv[2] === 'live' ? 'live' : process.argv[2] === 'dry' ? 'dry' : 'record'
  // Live is only reachable if the operator launched with explicit intent.
  const allowLive =
    process.argv.includes('--i-understand-live') ||
    process.argv.includes('--allow-live') ||
    process.env.BOT_I_UNDERSTAND_LIVE === '1' ||
    process.env.BOT_ALLOW_LIVE === '1'
  let halted = false
  const db = openDb(config.dbPath)
  const stream = new ChainlinkStream()

  const stats = { ticks: 0, predictions: 0, outcomes: 0, trades: 0, settled: 0 }
  /** Windows we've already entered this session — sync guard against the async
   * entry double-firing across ticks (DB tradeExists guards across restarts). */
  const entered = new Set<string>()
  /** dry paper executor by default; arming live swaps in the real one. */
  let executor = dryExecutor
  const STOP_FILE = resolve(process.cwd(), 'bot/STOP')
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
      (mode !== 'record'
        ? ` · entry ~T-${config.entryAtSec}s · edge≥${config.edgeThreshold} · $${config.stakeUsd}`
        : ''),
  )

  // --- LIVE arming: every guard must pass; returns an error instead of exiting
  // so the same path serves both startup and a runtime switch. ---
  async function armLive(): Promise<{ ok: boolean; error?: string; balance?: number }> {
    if (!allowLive) return { ok: false, error: 'live not permitted — start the bot with --allow-live' }
    if (!tradingEnabled()) return { ok: false, error: 'POLY_TRADING_ENABLED is 0/false' }
    if (config.stakeUsd > maxOrderCost()) {
      return { ok: false, error: `stake $${config.stakeUsd} exceeds POLY_MAX_ORDER_COST $${maxOrderCost()}` }
    }
    const { fetchAccountSnapshot } = await import('../api/_lib/clob')
    let snap: Awaited<ReturnType<typeof fetchAccountSnapshot>>
    try {
      snap = await fetchAccountSnapshot()
    } catch (e) {
      return { ok: false, error: `account check failed: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (!snap.canTrade) return { ok: false, error: `wallet not ready: ${snap.walletSetupIssue ?? 'missing signer/key'}` }
    if (!(snap.usdcBalance > 0)) return { ok: false, error: 'zero USDC balance' }
    executor = makeLiveExecutor()
    return { ok: true, balance: snap.usdcBalance }
  }

  async function setMode(next: BotMode): Promise<{ ok: boolean; error?: string }> {
    if (next === mode) return { ok: true }
    if (next === 'live') {
      const r = await armLive()
      if (!r.ok) return r
      log(`⚠ LIVE ARMED (control) · balance $${r.balance?.toFixed(2)} · stake $${config.stakeUsd} · max/order $${maxOrderCost()}`)
    } else {
      executor = dryExecutor
    }
    const prev = mode
    mode = next
    log(`mode ${prev} → ${next}`)
    return { ok: true }
  }

  function setHalted(next: boolean): void {
    if (next === halted) return
    halted = next
    log(halted ? 'entries HALTED (control)' : 'entries RESUMED (control)')
  }

  // Startup live still refuses hard (exit) — a launched-live bot that can't arm
  // shouldn't silently fall back to dry.
  if (mode === 'live') {
    const r = await armLive()
    if (!r.ok) {
      log(`LIVE refused — ${r.error}`)
      process.exit(1)
    }
    log(
      `⚠ LIVE ARMED · balance $${r.balance?.toFixed(2)} · stake $${config.stakeUsd} · ` +
        `max/order $${maxOrderCost()} · maxDaily ${config.maxDailyTrades} · maxOpen ${config.maxConcurrent} · ` +
        `create ${STOP_FILE} to halt entries`,
    )
  }

  // Entry: once per window, late (~T-10s), on a confident non-panic edge. Dry
  // paper-fills; live places a real FAK BUY. `bot/STOP` halts new entries.
  let stopLoggedAt = 0
  async function maybeTrade(pred: Prediction, market: ParsedMarket, now: number): Promise<void> {
    if (halted || existsSync(STOP_FILE)) {
      if (existsSync(STOP_FILE) && now - stopLoggedAt > 60_000) {
        stopLoggedAt = now
        log('STOP file present — entries halted')
      }
      return
    }
    if (entered.has(pred.windowKey) || db.tradeExists(pred.windowKey)) return
    if (db.countOpenTrades() >= config.maxConcurrent) return
    if (db.countTradesSince(now - 86_400_000) >= config.maxDailyTrades) return
    const order = decideEntry(pred, market, config, now)
    if (!order) return
    entered.add(pred.windowKey) // claim before the await so the next tick can't double-enter

    let fill
    try {
      fill = await executor.buy(order)
    } catch (e) {
      log(
        `${mode.toUpperCase()} ORDER FAILED ${pred.coin}/${pred.timeframe} ${order.side} — ` +
          (e instanceof Error ? e.message : String(e)),
      )
      return
    }
    if (!(fill.fillSize > 0 && fill.fillPrice > 0)) {
      log(`${mode.toUpperCase()} NO FILL ${pred.coin}/${pred.timeframe} ${order.side} (book empty / rejected)`)
      return
    }

    const cost = fill.fillPrice * fill.fillSize
    db.insertTrade({
      windowKey: pred.windowKey,
      coin: pred.coin,
      timeframe: pred.timeframe,
      mode,
      side: order.side,
      entryT: now,
      entryPrice: fill.fillPrice,
      size: fill.fillSize,
      cost,
      signalEdge: pred.edge,
      regimeEntry: pred.regime,
      status: 'open',
      orderId: fill.orderId,
    })
    stats.trades += 1
    log(
      `${mode.toUpperCase()} ENTER ${pred.coin}/${pred.timeframe} ${order.side} @ ${fill.fillPrice.toFixed(3)} · ` +
        `size ${fill.fillSize.toFixed(1)} · cost $${cost.toFixed(2)} · edge ${pred.edge.toFixed(3)} · ${pred.regime} · ` +
        `${Math.round((market.endDate.getTime() - now) / 1000)}s left${fill.orderId ? ` · ${fill.orderId.slice(0, 10)}` : ''}`,
    )
  }

  function settleTrades(now: number): void {
    for (const s of db.pendingSettlements()) {
      const won = s.side === s.outcome
      const payout = won ? s.size : 0
      const pnl = payout - s.cost
      db.settleTrade(s.id, now, payout, pnl)
      stats.settled += 1
      log(`${mode.toUpperCase()} SETTLE ${s.side} ${won ? 'WIN ' : 'loss'} · pnl ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)}`)
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
    if (mode !== 'record') void maybeTrade(pred, market, now)

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

  // --- control server for the dashboard Dry/Live switch ---
  const controlServer =
    process.env.BOT_CONTROL === '0'
      ? null
      : startControlServer(
          {
            getStatus: () => ({
              mode,
              allowLive,
              halted,
              connected: stream.connected,
              scopes: scopes.map((s) => `${s.coin}/${s.timeframe}`),
              liveScopes: scopes.filter((s) => s.market).length,
              stats: {
                ticks: stats.ticks,
                predictions: stats.predictions,
                outcomes: stats.outcomes,
                trades: stats.trades,
                settled: stats.settled,
              },
              summary: db.tradeSummary(),
            }),
            setMode,
            setHalted,
          },
          Number(process.env.BOT_CONTROL_PORT ?? 8790),
          process.env.BOT_CONTROL_TOKEN?.trim() || undefined,
          log,
        )

  let lastStatus = 0
  const timer = setInterval(() => {
    const now = Date.now()
    for (const state of scopes) {
      refreshMarket(state, now)
      sampleScope(state, now)
    }
    sweepOutcomes(now)
    if (mode !== 'record') settleTrades(now)

    if (now - lastStatus >= STATUS_MS) {
      lastStatus = now
      const live = scopes.filter((s) => s.market).length
      log(
        `[${mode}] ws=${stream.connected ? 'up' : 'down'} · live=${live}/${scopes.length} · ` +
          `ticks=${stats.ticks} preds=${stats.predictions} outcomes=${stats.outcomes}` +
          (mode !== 'record'
            ? ` · trades=${stats.trades} settled=${stats.settled} open=${db.countOpenTrades()}`
            : '') +
          ` · pending=${tracked.size}`,
      )
    }
  }, config.tickMs)

  const shutdown = (): void => {
    clearInterval(timer)
    controlServer?.close()
    stream.stop()
    db.close()
    log(`${mode} stopped`)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main()
