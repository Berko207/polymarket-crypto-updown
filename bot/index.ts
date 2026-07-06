/**
 * Bot entry. Streams Chainlink ticks + gamma odds for every in-scope market,
 * logs flat+regime predictions and outcomes to SQLite, and (dry/live) trades value
 * entries (model edge on the cheap side, hold to settlement). Mode is runtime-switchable
 *   record → log only · dry → paper-trade · live → real FAK orders (gated)
 */
import '../api/_lib/loadEnv' // side effect: load .env.local (POLY_* for live, BOT_* overrides)
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { activeScopes, loadConfig } from './config'
import { openDb } from './db'
import { loadRuntimeSettings, saveRuntimeSettings } from './runtime'
import { ChainlinkStream } from './sources/chainlink'
import { fetchCurrentMarket } from './sources/gamma'
import { predict, type Prediction } from './engine/predict'
import { decideEntry, entryBlockReason } from './engine/strategy'
import { decideSwingEntry, decideExit, deriveBook, bidForSide, sourceEdge, type MidPoint } from './engine/swing'
import { takerFee } from './engine/fees'
import { dryExecutor, isInsufficientBalanceError, makeLiveExecutor, type SellOrder } from './engine/executor'
import { ClobMarketStream, type TradePrint } from './sources/clobMarket'
import { MakerSimExecutor, type MakerFill, type MakerQuote } from './engine/makerExecutor'
import { decideQuotes, type MakerContext, type MakerInventory } from './engine/maker'
import { emptyAccount, applyFill, flatten as flattenAccount, settle as settleAccount } from './engine/makerAccount'
import { maxOrderCost, tradingEnabled } from './engine/guards'
import { startControlServer, type BotMode, type BotStatus } from './control'
import { VOL_LOOKBACK_MS } from '../src/lib/fairValue'
import { marketWindowKey, windowEndMsFromKey } from '../src/lib/marketScope'
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
/** Live-only fallback when BOT_MAX_DAILY_TRADES is unset/0 — paper has no cap. */
const LIVE_DEFAULT_DAILY_CAP = 50
/** Retry cadence for force-closing a position that couldn't fill (empty/thin book). */
const CLOSE_RETRY_MS = 3_000
const RUNTIME_PATH = resolve(process.cwd(), 'bot/runtime.json')

function log(...args: unknown[]): void {
  console.info(new Date().toISOString(), ...args)
}

async function main(): Promise<void> {
  const config = loadConfig()
  const runtime = loadRuntimeSettings(RUNTIME_PATH)
  if (
    runtime.maxDailyTrades != null &&
    Number.isInteger(runtime.maxDailyTrades) &&
    runtime.maxDailyTrades >= 0
  ) {
    config.maxDailyTrades = runtime.maxDailyTrades
  }
  // Mutable at runtime so the dashboard can flip the switch without a restart.
  // 'paper' is an alias for the wire mode 'dry' (paper-trading, no real orders).
  const launchArg = process.argv[2]
  let mode: BotMode =
    launchArg === 'live' ? 'live' : launchArg === 'dry' || launchArg === 'paper' ? 'dry' : 'record'
  // Live is only reachable if the operator launched with explicit intent.
  const allowLive =
    process.argv.includes('--i-understand-live') ||
    process.argv.includes('--allow-live') ||
    process.env.BOT_I_UNDERSTAND_LIVE === '1' ||
    process.env.BOT_ALLOW_LIVE === '1'
  let halted = false
  const db = openDb(config.dbPath)
  const repaired = db.repairDustLiveFills(config.stakeUsd)
  if (repaired > 0) log(`repaired ${repaired} dust live fill(s) in trade history`)
  const stream = new ChainlinkStream()

  // --- maker strategy infra (strategy='maker'). The CLOB market socket supplies
  // the depth + trade tape the fill sim needs; only subscribed while maker is active. ---
  const makerStream = new ClobMarketStream()
  makerStream.start()
  const makerExec = new MakerSimExecutor({
    fillModel: config.makerFillModel,
    rebateRate: config.makerRebateRate,
  })
  /** Net inventory (shares) per window. */
  const makerInv = new Map<string, MakerInventory>()
  /** Per-window running accounting (cash out, rebate, flatten proceeds, fees). */
  interface MakerAcct {
    coin: string
    timeframe: string
    regime: string | null
    entryT: number
    cashSpent: number
    rebate: number
    flatten: number
    fees: number
    grossShares: number
  }
  const makerAcct = new Map<string, MakerAcct>()
  /** Per-window meta captured while quoting (tokens/tick/end), for fills + settlement. */
  interface MakerMeta {
    coin: string
    timeframe: string
    regime: string | null
    upTokenId: string | null
    downTokenId: string | null
    tickSize: number | null
    endMs: number
  }
  const makerMeta = new Map<string, MakerMeta>()
  /** `${windowKey}:${side}` → last requote ts (rate-limit). */
  const makerLastRequote = new Map<string, number>()
  let makerStepAt = 0

  const stats = { ticks: 0, predictions: 0, outcomes: 0, trades: 0, settled: 0, makerFills: 0 }
  /** Windows successfully entered this session (DB tradeExists guards restarts). */
  const entered = new Set<string>()
  /** In-flight value-entry guard — mirrors enteringSwing so a slow buy can't double-fire. */
  const enteringValue = new Set<string>()
  /** dry paper executor by default; arming live swaps in the real one. */
  let executor = dryExecutor
  /** Last known CLOB USDC balance — refreshed when arming live and after fills. */
  let cachedUsdcBalance: number | null = null
  /** Per-window backoff after a genuine insufficient-USDC rejection (avoids log spam). */
  const balanceBlockedUntil = new Map<string, number>()
  /** One skip-reason line per window per session (entry-window diagnostics). */
  const entrySkipLogged = new Set<string>()
  /** Back off retries after an empty-book NO FILL (edge can persist with no asks). */
  const entryRetryAfter = new Map<string, number>()
  const entryAttemptCount = new Map<string, number>()
  const ENTRY_NO_FILL_BACKOFF_MS = 3_000
  const ENTRY_MAX_ATTEMPTS = 4
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

  // Timeframes entries currently fire on (a subset of the recorded scopes above).
  // Mutable so the dashboard can widen/narrow trading without a restart; every
  // timeframe is still recorded regardless of what's in here.
  const recordedTf = new Set<TimeframeId>(scopes.map((s) => s.timeframe))
  const tradeTf = new Set<TimeframeId>(config.tradeTimeframes.filter((tf) => recordedTf.has(tf)))

  const lastSample = new Map<string, number>()
  const tracked = new Map<string, TrackedWindow>()
  // Swing state: recent mids per window (swing detection), per-window re-entry
  // cooldown, and in-flight guards so an async buy/sell can't double-fire.
  const midHistory = new Map<string, MidPoint[]>()
  const swingCooldown = new Map<string, number>()
  const enteringSwing = new Set<string>()
  const exitingTrades = new Set<number>()
  // Positions queued to force-close at market (strategy switch): id → exit reason.
  // Retried every CLOSE_RETRY_MS until each fills or its window ends.
  const pendingClose = new Map<number, string>()
  let draining = false
  let lastCloseDrain = 0

  const strategyBrief =
    config.strategy === 'swing'
      ? `swing/${config.swingTrigger} · src ${config.signalSource} · edge≥${config.swingEdgeMin}` +
        (config.swingTrigger === 'move' ? ` · move≥${config.swingMovePts}/${config.swingWindowSec}s` : '') +
        ` · band ${config.swingMinPrice}-${config.swingMaxPrice}${config.swingSkipCalm ? ' · skipCalm' : ''}` +
        ` · TP ${config.swingTakeProfitPts}/SL ${config.swingStopLossPts} · timeStop ${config.swingTimeStopSec}s · ` +
        `fee ${config.feeRate}${config.feeSell ? '+sell' : ''}`
      : config.strategy === 'maker'
        ? `maker/${config.makerFillModel} · src ${config.signalSource} · spread±${config.makerBaseSpread} ` +
          `(+${config.makerVolCoef}σ) · clip $${config.makerClipUsd} · maxInv ${config.makerMaxInventory} · ` +
          `skew ${config.makerInvSkew} · rebate ${config.makerRebateRate} · pull ${config.makerPullSec}s/flatten ${config.makerFlattenSec}s`
        : `value · edge≥${config.edgeThreshold} · ask≤${config.valueMaxEntryPrice}`
  log(
    `${mode} up · db=${config.dbPath} · scopes=${scopes.map((s) => `${s.coin}/${s.timeframe}`).join(',')}` +
      (mode !== 'record'
        ? ` · trade[${config.timeframes.filter((tf) => tradeTf.has(tf)).join(',') || 'none'}] · ${strategyBrief} · $${config.stakeUsd}`
        : ''),
  )

  // --- LIVE arming: every guard must pass; returns an error instead of exiting
  // so the same path serves both startup and a runtime switch. ---
  async function armLive(): Promise<{ ok: boolean; error?: string; balance?: number }> {
    if (!allowLive) return { ok: false, error: 'live not permitted — run pnpm bot:live (or restart with --allow-live)' }
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
    if (config.stakeUsd > snap.usdcBalance) {
      return {
        ok: false,
        error: `stake $${config.stakeUsd} exceeds USDC balance $${snap.usdcBalance.toFixed(2)}`,
      }
    }
    cachedUsdcBalance = snap.usdcBalance
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

  const MIN_STAKE_USD = 1

  function setStakeUsd(next: number): { ok: boolean; error?: string } {
    if (!Number.isFinite(next) || next < MIN_STAKE_USD) {
      return { ok: false, error: `stake must be at least $${MIN_STAKE_USD}` }
    }
    const cap = maxOrderCost()
    if (next > cap) return { ok: false, error: `stake $${next} exceeds max order cost $${cap}` }
    if (mode === 'live' && cachedUsdcBalance != null && next > cachedUsdcBalance) {
      return {
        ok: false,
        error: `stake $${next} exceeds USDC balance $${cachedUsdcBalance.toFixed(2)}`,
      }
    }
    if (next === config.stakeUsd) return { ok: true }
    const prev = config.stakeUsd
    config.stakeUsd = next
    log(`stake $${prev} → $${next} (control)`)
    return { ok: true }
  }

  function setStrategy(next: 'value' | 'swing' | 'maker'): { ok: boolean; error?: string } {
    if (next !== 'value' && next !== 'swing' && next !== 'maker') {
      return { ok: false, error: 'strategy must be value|swing|maker' }
    }
    if (next === config.strategy) return { ok: true }
    const prev = config.strategy
    config.strategy = next
    log(`strategy ${prev} → ${next} (control)`)
    // Leaving maker: cancel resting quotes and unsubscribe the CLOB feed. Any open
    // maker inventory is finalized on its window end by finalizeMakerWindows.
    if (prev === 'maker' && next !== 'maker') {
      makerExec.cancelAll()
      makerStream.setTokens([])
    }
    // Market-close positions from the old regime so they realize now instead of
    // riding to settlement. The flip is instant; drainPendingCloses keeps retrying
    // the sells (empty/thin book) each cycle until filled or the window settles.
    if (db.countOpenTrades() > 0) requestCloseAllOpen('strategy-switch')
    return { ok: true }
  }

  function setTradeTimeframes(next: string[]): { ok: boolean; error?: string } {
    if (!Array.isArray(next)) return { ok: false, error: 'timeframes must be an array' }
    const uniq = [
      ...new Set(
        next
          .map((t) => String(t).trim().toLowerCase())
          .filter((t): t is TimeframeId => recordedTf.has(t as TimeframeId)),
      ),
    ]
    if (uniq.length === 0) {
      return { ok: false, error: 'select at least one recorded timeframe (use Halt to pause all entries)' }
    }
    tradeTf.clear()
    for (const t of uniq) tradeTf.add(t)
    config.tradeTimeframes = uniq
    log(`trade timeframes → ${uniq.join(',')} (control)`)
    return { ok: true }
  }

  function setMaker(patch: {
    baseSpread?: number
    clipUsd?: number
    maxInventory?: number
    fillModel?: 'L1' | 'L2'
    rebateRate?: number
  }): { ok: boolean; error?: string } {
    const applied: string[] = []
    if (patch.baseSpread != null) {
      if (!(patch.baseSpread > 0 && patch.baseSpread < 0.5)) {
        return { ok: false, error: 'half-spread must be between 0 and 0.5' }
      }
      config.makerBaseSpread = patch.baseSpread
      applied.push(`spread±${patch.baseSpread}`)
    }
    if (patch.clipUsd != null) {
      if (!(patch.clipUsd > 0)) return { ok: false, error: 'clip must be > 0' }
      config.makerClipUsd = patch.clipUsd
      applied.push(`clip $${patch.clipUsd}`)
    }
    if (patch.maxInventory != null) {
      if (!(patch.maxInventory > 0)) return { ok: false, error: 'max inventory must be > 0' }
      config.makerMaxInventory = patch.maxInventory
      applied.push(`maxInv ${patch.maxInventory}`)
    }
    if (patch.rebateRate != null) {
      if (!(patch.rebateRate >= 0)) return { ok: false, error: 'rebate must be ≥ 0' }
      config.makerRebateRate = patch.rebateRate
      applied.push(`rebate ${patch.rebateRate}`)
    }
    if (patch.fillModel != null) {
      config.makerFillModel = patch.fillModel
      applied.push(`fill ${patch.fillModel}`)
    }
    if (applied.length === 0) return { ok: false, error: 'no maker fields to update' }
    // spread/clip/maxInv are read fresh from config by decideQuotes each tick;
    // fillModel + rebateRate are cached inside the sim executor — sync them.
    makerExec.setOptions({ fillModel: config.makerFillModel, rebateRate: config.makerRebateRate })
    log(`maker config → ${applied.join(' · ')} (control)`)
    return { ok: true }
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
        `max/order $${maxOrderCost()} · maxDaily ${effectiveDailyCap() || '∞'} · maxOpen ${config.maxConcurrent} · ` +
        `create ${STOP_FILE} to halt entries`,
    )
  }

  // Shared entry gate: halted flag or a `bot/STOP` file suspends all new entries.
  let stopLoggedAt = 0
  function entriesHalted(now: number): boolean {
    if (halted || existsSync(STOP_FILE)) {
      if (existsSync(STOP_FILE) && now - stopLoggedAt > 60_000) {
        stopLoggedAt = now
        log('STOP file present — entries halted')
      }
      return true
    }
    return false
  }

  /** 0 = unlimited (paper/record); live uses LIVE_DEFAULT_DAILY_CAP when unset. */
  function effectiveDailyCap(): number {
    if (config.maxDailyTrades > 0) return config.maxDailyTrades
    return mode === 'live' ? LIVE_DEFAULT_DAILY_CAP : 0
  }

  function setMaxDailyTrades(next: number): { ok: boolean; error?: string } {
    if (!Number.isFinite(next) || next < 0 || !Number.isInteger(next)) {
      return { ok: false, error: 'maxDailyTrades must be a non-negative integer (0 = mode default)' }
    }
    if (next === config.maxDailyTrades) return { ok: true }
    const prev = effectiveDailyCap()
    config.maxDailyTrades = next
    saveRuntimeSettings(RUNTIME_PATH, { maxDailyTrades: next })
    log(`daily cap ${prev || '∞'} → ${effectiveDailyCap() || '∞'} (control)`)
    return { ok: true }
  }

  function dailyCapReached(now: number): boolean {
    const cap = effectiveDailyCap()
    if (cap <= 0) return false
    return db.countTradesSince(now - 86_400_000) >= cap
  }

  // Value entry: once per window when edge clears and the ask is cheap enough.
  // Dry paper-fills; live places a real FAK BUY. Retries a few times with backoff
  // after NO FILL so an empty book isn't hammered every tick.
  async function maybeTrade(pred: Prediction, market: ParsedMarket, now: number): Promise<void> {
    if (entriesHalted(now)) return
    if (entered.has(pred.windowKey) || db.tradeExists(pred.windowKey)) return
    if (enteringValue.has(pred.windowKey)) return
    if ((balanceBlockedUntil.get(pred.windowKey) ?? 0) > now) return
    if ((entryRetryAfter.get(pred.windowKey) ?? 0) > now) return
    if ((entryAttemptCount.get(pred.windowKey) ?? 0) >= ENTRY_MAX_ATTEMPTS) return
    if (db.countOpenTrades() >= config.maxConcurrent) return
    if (dailyCapReached(now)) return
    const order = decideEntry(pred, market, config, now)
    if (!order) {
      const block = entryBlockReason(pred, market, config, now)
      if (block) {
        const key = `${pred.windowKey}:${block}`
        if (!entrySkipLogged.has(key)) {
          entrySkipLogged.add(key)
          log(
            `${mode.toUpperCase()} SKIP ${pred.coin}/${pred.timeframe} — ${block} · ` +
              `${Math.round((market.endDate.getTime() - now) / 1000)}s left`,
          )
        }
      }
      return
    }

    const secLeft = Math.round((market.endDate.getTime() - now) / 1000)
    const attempt = (entryAttemptCount.get(pred.windowKey) ?? 0) + 1
    entryAttemptCount.set(pred.windowKey, attempt)
    log(
      `${mode.toUpperCase()} ATTEMPT ${pred.coin}/${pred.timeframe} ${order.side} @ ${order.fillPrice.toFixed(3)} · ` +
        `$${order.stakeUsd} · edge ${pred.edge.toFixed(3)} · ${pred.regime ?? '—'} · ${secLeft}s left · try ${attempt}/${ENTRY_MAX_ATTEMPTS}`,
    )

    enteringValue.add(pred.windowKey)
    let fill
    try {
      fill = await executor.buy(order)
    } catch (e) {
      enteringValue.delete(pred.windowKey)
      const msg = e instanceof Error ? e.message : String(e)
      if (isInsufficientBalanceError(msg)) {
        balanceBlockedUntil.set(pred.windowKey, now + 30_000)
        log(
          `${mode.toUpperCase()} SKIP ${pred.coin}/${pred.timeframe} ${order.side} — ${msg} ` +
            `(deposit or lower stake; pausing retries 30s)`,
        )
        return
      }
      log(
        `${mode.toUpperCase()} ORDER FAILED ${pred.coin}/${pred.timeframe} ${order.side} @ ${order.fillPrice.toFixed(3)} · ` +
          `$${order.stakeUsd} · ${secLeft}s left — ${msg}` +
          (attempt < ENTRY_MAX_ATTEMPTS ? ` (retry in ${ENTRY_NO_FILL_BACKOFF_MS / 1000}s)` : ' (max attempts)'),
      )
      if (attempt < ENTRY_MAX_ATTEMPTS) entryRetryAfter.set(pred.windowKey, now + ENTRY_NO_FILL_BACKOFF_MS)
      return
    }
    enteringValue.delete(pred.windowKey)
    if (!(fill.fillSize > 0 && fill.fillPrice > 0)) {
      log(
        `${mode.toUpperCase()} NO FILL ${pred.coin}/${pred.timeframe} ${order.side} @ ${order.fillPrice.toFixed(3)} · ` +
          `$${order.stakeUsd} · ${secLeft}s left — book empty / FAK killed` +
          (attempt < ENTRY_MAX_ATTEMPTS ? ` (retry in ${ENTRY_NO_FILL_BACKOFF_MS / 1000}s)` : ' (max attempts)'),
      )
      if (attempt < ENTRY_MAX_ATTEMPTS) entryRetryAfter.set(pred.windowKey, now + ENTRY_NO_FILL_BACKOFF_MS)
      return
    }

    const cost = fill.fillPrice * fill.fillSize
    if (mode === 'live' && cost < order.stakeUsd * 0.9) {
      log(
        `${mode.toUpperCase()} NO FILL ${pred.coin}/${pred.timeframe} ${order.side} ` +
          `(dust fill $${cost.toFixed(4)} on $${order.stakeUsd} order — not recording)`,
      )
      return
    }
    entered.add(pred.windowKey)
    if (mode === 'live') cachedUsdcBalance = cachedUsdcBalance == null ? null : cachedUsdcBalance - cost
    db.insertTrade({
      windowKey: pred.windowKey,
      coin: pred.coin,
      timeframe: pred.timeframe,
      mode,
      strategy: 'value',
      side: order.side,
      entryT: now,
      entryPrice: fill.fillPrice,
      size: fill.fillSize,
      cost,
      entryFee: 0,
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

  // --- Swing scalp: record the mid, manage open exits, then consider an entry. ---
  function recordMid(pred: Prediction, now: number): void {
    const hist = midHistory.get(pred.windowKey) ?? []
    hist.push({ t: now, mid: pred.marketP })
    // Keep a little more than the detection lookback.
    const cutoff = now - (config.swingWindowSec + 10) * 1_000
    while (hist.length && hist[0].t < cutoff) hist.shift()
    midHistory.set(pred.windowKey, hist)
  }

  async function swingExit(pred: Prediction, market: ParsedMarket, now: number): Promise<void> {
    for (const pos of db.openTradesForWindow(pred.windowKey)) {
      if (pos.strategy !== 'swing' || exitingTrades.has(pos.id)) continue
      const exit = decideExit(pos, pred, market, config, now)
      if (!exit) continue
      const tokenId = pos.side === 'up' ? market.upTokenId : market.downTokenId
      if (!tokenId) continue
      const sellOrder: SellOrder = {
        side: pos.side,
        tokenId,
        size: pos.size,
        sellPrice: exit.mark,
        tickSize: market.tickSize,
        negRisk: market.negRisk,
      }
      exitingTrades.add(pos.id)
      let fill
      try {
        fill = await executor.sell(sellOrder)
      } catch (e) {
        exitingTrades.delete(pos.id)
        log(
          `${mode.toUpperCase()} SELL FAILED #${pos.id} ${pos.side} — ` +
            `${e instanceof Error ? e.message : String(e)} (will retry)`,
        )
        continue
      }
      exitingTrades.delete(pos.id)
      if (!(fill.fillSize > 0 && fill.fillPrice > 0)) {
        // Unmatched — empty/thin book. Retry next tick while exit conditions hold.
        continue
      }
      const exitFee = config.feeSell ? takerFee(fill.fillPrice, fill.fillSize, config.feeRate) : 0
      const payout = fill.fillPrice * fill.fillSize - exitFee
      const pnl = payout - pos.cost
      db.closeTrade({ id: pos.id, exitT: now, exitPrice: fill.fillPrice, exitReason: exit.reason, exitFee, payout, pnl })
      swingCooldown.set(pred.windowKey, now)
      stats.settled += 1
      log(
        `${mode.toUpperCase()} EXIT ${exit.reason} ${pred.coin}/${pred.timeframe} ${pos.side} @ ${fill.fillPrice.toFixed(3)} · ` +
          `pnl ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)} · ${Math.round((market.endDate.getTime() - now) / 1000)}s left`,
      )
    }
  }

  async function swingEnter(pred: Prediction, market: ParsedMarket, now: number): Promise<void> {
    if (entriesHalted(now)) return
    if (enteringSwing.has(pred.windowKey)) return
    // One open swing position per window at a time; cooldown after a close.
    if (db.openTradesForWindow(pred.windowKey).some((t) => t.strategy === 'swing')) return
    if (now - (swingCooldown.get(pred.windowKey) ?? 0) < config.swingCooldownSec * 1_000) return
    if (db.countOpenTrades() >= config.maxConcurrent) return
    if (dailyCapReached(now)) return
    const order = decideSwingEntry(pred, market, midHistory.get(pred.windowKey) ?? [], config, now)
    if (!order) return

    enteringSwing.add(pred.windowKey)
    let fill
    try {
      fill = await executor.buy(order)
    } catch (e) {
      enteringSwing.delete(pred.windowKey)
      const msg = e instanceof Error ? e.message : String(e)
      if (isInsufficientBalanceError(msg)) {
        balanceBlockedUntil.set(pred.windowKey, now + 30_000)
        log(
          `${mode.toUpperCase()} SKIP swing ${pred.coin}/${pred.timeframe} ${order.side} — ${msg} ` +
            `(deposit or lower stake; pausing retries 30s)`,
        )
        return
      }
      log(
        `${mode.toUpperCase()} ORDER FAILED ${pred.coin}/${pred.timeframe} ${order.side} — ` +
          `${msg} (will retry)`,
      )
      return
    }
    enteringSwing.delete(pred.windowKey)
    if (!(fill.fillSize > 0 && fill.fillPrice > 0)) {
      // Retries next tick while decideSwingEntry still qualifies (edge/move/band).
      return
    }
    const entryFee = takerFee(fill.fillPrice, fill.fillSize, config.feeRate)
    const cost = fill.fillPrice * fill.fillSize + entryFee
    if (mode === 'live' && fill.fillPrice * fill.fillSize < order.stakeUsd * 0.9) {
      return
    }
    if (mode === 'live') cachedUsdcBalance = cachedUsdcBalance == null ? null : cachedUsdcBalance - cost
    const signalEdge = sourceEdge(pred, config.signalSource)
    db.insertTrade({
      windowKey: pred.windowKey,
      coin: pred.coin,
      timeframe: pred.timeframe,
      mode,
      strategy: 'swing',
      side: order.side,
      entryT: now,
      entryPrice: fill.fillPrice,
      size: fill.fillSize,
      cost,
      entryFee,
      signalEdge,
      regimeEntry: pred.regime,
      status: 'open',
      orderId: fill.orderId,
    })
    stats.trades += 1
    log(
      `${mode.toUpperCase()} ENTER swing/${config.swingTrigger} ${pred.coin}/${pred.timeframe} ${order.side} @ ${fill.fillPrice.toFixed(3)} · ` +
        `size ${fill.fillSize.toFixed(1)} · cost $${cost.toFixed(2)} · edge ${signalEdge.toFixed(3)} (${config.signalSource}) · ${pred.regime} · ` +
        `${Math.round((market.endDate.getTime() - now) / 1000)}s left`,
    )
  }

  // Manage exits before entries so a stop/take-profit frees the per-window slot.
  // Exits run even when this timeframe isn't currently tradable, so toggling a
  // timeframe off from the dashboard never strands an open scalp mid-window.
  async function manageSwing(
    pred: Prediction,
    market: ParsedMarket,
    now: number,
    canEnter: boolean,
  ): Promise<void> {
    await swingExit(pred, market, now)
    if (canEnter) await swingEnter(pred, market, now)
  }

  // --- Maker strategy (strategy='maker'): post two-sided passive quotes, book
  // simulated fills off the trade tape, flatten near the boundary, settle at end.
  // See docs/maker-paper-strategy.md. ---

  /** Advance the fill sim against trade prints since the last step; book any fills. */
  function makerStep(now: number): void {
    const orders = makerExec.open()
    if (orders.length === 0) {
      makerStepAt = now
      return
    }
    const since = makerStepAt || now - 3_000
    const byToken = new Map<string, TradePrint[]>()
    for (const o of orders) {
      if (!byToken.has(o.tokenId)) byToken.set(o.tokenId, makerStream.tradesSince(o.tokenId, since))
    }
    const fills = makerExec.step(byToken)
    makerStepAt = now
    for (const fill of fills) applyMakerFill(fill, now)
  }

  function applyMakerFill(fill: MakerFill, now: number): void {
    const inv = makerInv.get(fill.windowKey) ?? { upShares: 0, downShares: 0 }
    const meta = makerMeta.get(fill.windowKey)
    const acct =
      makerAcct.get(fill.windowKey) ??
      ({
        coin: meta?.coin ?? fill.windowKey,
        timeframe: meta?.timeframe ?? '',
        regime: meta?.regime ?? null,
        entryT: now,
        ...emptyAccount(),
      } satisfies MakerAcct)
    applyFill(acct, inv, fill)
    makerInv.set(fill.windowKey, inv)
    makerAcct.set(fill.windowKey, acct)

    db.insertMakerFill({
      windowKey: fill.windowKey,
      coin: acct.coin,
      timeframe: acct.timeframe,
      mode,
      tokenSide: fill.side,
      fillT: fill.t,
      price: fill.price,
      size: fill.size,
      rebate: fill.rebate,
      fillModel: config.makerFillModel,
      orderId: fill.orderId,
    })
    stats.makerFills += 1
  }

  /** Seed L2 queue-ahead from live depth at the quote's price (0 under L1). */
  function postMakerQuote(q: MakerQuote, now: number): void {
    const qAhead = config.makerFillModel === 'L2' ? makerStream.depthAt(q.tokenId, 'bid', q.price) : 0
    makerExec.post(q, now, qAhead)
  }

  /** Diff desired quotes against resting ones: cancel stale, keep matches, post new. */
  function reconcileMakerQuotes(windowKey: string, desired: MakerQuote[], now: number): void {
    const resting = makerExec.open(windowKey)
    const want = new Set(desired.map((d) => d.side))
    for (const o of resting) if (!want.has(o.side)) makerExec.cancel(o.id)
    const bySide = new Map(resting.map((o) => [o.side, o] as const))
    for (const d of desired) {
      const cur = bySide.get(d.side)
      const key = `${windowKey}:${d.side}`
      if (!cur) {
        postMakerQuote(d, now)
        makerLastRequote.set(key, now)
        continue
      }
      const priceMoved = Math.abs(cur.price - d.price) >= config.makerRequoteEdge
      const canRequote = now - (makerLastRequote.get(key) ?? 0) >= config.makerMinRequoteMs
      if (priceMoved && canRequote) {
        // Cancel-replace resets queue position — the modeled cost of over-requoting.
        makerExec.cancel(cur.id)
        postMakerQuote(d, now)
        makerLastRequote.set(key, now)
      }
    }
  }

  /** Per-window each tick: capture meta, manage the boundary, then (re)quote. */
  function manageMaker(pred: Prediction, market: ParsedMarket, now: number, canEnter: boolean): void {
    makerMeta.set(pred.windowKey, {
      coin: pred.coin,
      timeframe: pred.timeframe,
      regime: pred.regime,
      upTokenId: market.upTokenId,
      downTokenId: market.downTokenId,
      tickSize: market.tickSize,
      endMs: market.endDate.getTime(),
    })
    const msRemaining = market.endDate.getTime() - now
    // Flatten residual inventory just before close (unless holding to settlement).
    if (!config.makerLetRide && msRemaining <= config.makerFlattenSec * 1_000) {
      makerExec.cancelWindow(pred.windowKey)
      flattenMakerWindow(pred.windowKey, now)
      return
    }
    // Stop quoting when pulled, halted, or this timeframe isn't currently traded.
    if (msRemaining <= config.makerPullSec * 1_000 || entriesHalted(now) || !canEnter) {
      makerExec.cancelWindow(pred.windowKey)
      return
    }
    const inv = makerInv.get(pred.windowKey) ?? { upShares: 0, downShares: 0 }
    const ctx: MakerContext = {
      pred,
      upBook: market.upTokenId ? makerStream.book(market.upTokenId) : null,
      downBook: market.downTokenId ? makerStream.book(market.downTokenId) : null,
      upTokenId: market.upTokenId,
      downTokenId: market.downTokenId,
      tickSize: market.tickSize,
      msRemaining,
    }
    reconcileMakerQuotes(pred.windowKey, decideQuotes(ctx, inv, config), now)
  }

  /** Cross the spread to flatten the net position at the book bid (a sell → fee-exempt today). */
  function flattenMakerWindow(windowKey: string, now: number): void {
    const inv = makerInv.get(windowKey)
    const acct = makerAcct.get(windowKey)
    const meta = makerMeta.get(windowKey)
    if (!inv || !acct || !meta) return
    const q = inv.upShares - inv.downShares
    if (Math.abs(q) < 1e-6) return
    const sellSide: 'up' | 'down' = q > 0 ? 'up' : 'down'
    const tokenId = sellSide === 'up' ? meta.upTokenId : meta.downTokenId
    const bid = tokenId ? makerStream.book(tokenId)?.bestBid ?? null : null
    const leg = flattenAccount(acct, inv, bid, config.feeRate, config.feeSell)
    if (!leg) return // no book to sell into → residual settles at the boundary
    makerInv.set(windowKey, inv)
    db.insertMakerFill({
      windowKey,
      coin: acct.coin,
      timeframe: acct.timeframe,
      mode,
      tokenSide: leg.side,
      fillT: now,
      price: leg.price,
      size: -leg.qty, // negative size marks a flatten sell in the ledger
      rebate: 0,
      fillModel: `${config.makerFillModel}-flatten`,
      orderId: null,
    })
    log(
      `${mode.toUpperCase()} MAKER FLATTEN ${acct.coin}/${acct.timeframe} sold ${leg.qty.toFixed(1)} ${leg.side} @ ${leg.price.toFixed(3)}`,
    )
  }

  /** After a window ends, settle residual inventory ($1/$0) and write one summary row. */
  function finalizeMakerWindows(now: number): void {
    for (const [windowKey, acct] of makerAcct) {
      const endMs = makerMeta.get(windowKey)?.endMs ?? windowEndMsFromKey(windowKey)
      if (endMs == null || now <= endMs + 2_000) continue
      const inv = makerInv.get(windowKey) ?? { upShares: 0, downShares: 0 }
      const residual = Math.abs(inv.upShares - inv.downShares)
      const outcome = db.outcomeFor(windowKey)
      // Wait for the boundary outcome before settling residual inventory (give up late).
      if (residual > 1e-6 && outcome == null && now <= endMs + OUTCOME_GIVEUP_MS) continue

      const s = settleAccount(acct, inv, outcome)
      db.insertMakerTrade({
        windowKey,
        coin: acct.coin,
        timeframe: acct.timeframe,
        mode,
        side: s.side,
        entryT: acct.entryT,
        entryPrice: s.entryPrice,
        size: s.size,
        cost: s.cost,
        entryFee: acct.fees,
        regimeEntry: acct.regime,
        settleT: now,
        payout: s.payout,
        pnl: s.pnl,
      })
      makerAcct.delete(windowKey)
      makerInv.delete(windowKey)
      makerMeta.delete(windowKey)
      makerLastRequote.delete(`${windowKey}:up`)
      makerLastRequote.delete(`${windowKey}:down`)
      makerExec.cancelWindow(windowKey)
      stats.settled += 1
      log(
        `${mode.toUpperCase()} MAKER SETTLE ${acct.coin}/${acct.timeframe} · ` +
          `fills ${acct.grossShares.toFixed(1)}sh · staked $${s.cost.toFixed(2)} · ` +
          `rebate $${acct.rebate.toFixed(3)} · pnl ${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(3)}`,
      )
    }
  }

  // Queue every open position to be force-closed at market (used on a strategy
  // switch). The selling is retried each cycle by drainPendingCloses until each
  // fills or its window ends, so an empty/thin book doesn't strand the switch.
  function requestCloseAllOpen(reason: string): void {
    let n = 0
    for (const t of db.openTrades()) {
      if (!pendingClose.has(t.id)) {
        pendingClose.set(t.id, reason)
        n += 1
      }
    }
    if (n > 0) {
      log(`  queued ${n} open position(s) to close at market (${reason}) — retrying until filled or settled`)
      void drainPendingCloses()
    }
  }

  // Attempt to market-close each queued position at the current bid. One that
  // can't fill now (no/thin book) stays queued and is retried next cycle; once its
  // window ends it's dropped (settleTrades resolves it). Mirrors swingExit's sell.
  async function drainPendingCloses(): Promise<void> {
    if (draining || pendingClose.size === 0) return
    draining = true
    try {
      const live = new Map<string, ParsedMarket>()
      for (const sc of scopes) if (sc.market) live.set(marketWindowKey(sc.market), sc.market)
      const openById = new Map(db.openTrades().map((t) => [t.id, t] as const))
      for (const [id, reason] of [...pendingClose]) {
        if (exitingTrades.has(id)) continue
        const pos = openById.get(id)
        if (!pos) {
          pendingClose.delete(id) // already closed/settled elsewhere
          continue
        }
        const market = live.get(pos.windowKey)
        const tokenId = market ? (pos.side === 'up' ? market.upTokenId : market.downTokenId) : null
        const mark = market ? bidForSide(deriveBook(market), pos.side) : null
        if (!market || !tokenId || !(mark != null && mark > 0)) {
          // No book to sell into right now. Keep retrying while the window is open;
          // once it ends, settleTrades takes over, so stop tracking it.
          const endMs = market?.endDate.getTime() ?? windowEndMsFromKey(pos.windowKey)
          if (endMs != null && Date.now() > endMs) {
            pendingClose.delete(id)
            log(`${mode.toUpperCase()} CLOSE give-up #${id} ${pos.coin}/${pos.timeframe} — no book, leaving to settle`)
          }
          continue
        }
        const sellOrder: SellOrder = {
          side: pos.side,
          tokenId,
          size: pos.size,
          sellPrice: mark,
          tickSize: market.tickSize,
          negRisk: market.negRisk,
        }
        exitingTrades.add(id)
        let fill
        try {
          fill = await executor.sell(sellOrder)
        } catch (e) {
          exitingTrades.delete(id)
          log(`${mode.toUpperCase()} CLOSE FAILED #${id} ${pos.side} — ${e instanceof Error ? e.message : String(e)} (will retry)`)
          continue
        }
        exitingTrades.delete(id)
        if (!(fill.fillSize > 0 && fill.fillPrice > 0)) {
          // Unmatched — empty/thin book. Stay queued and retry next cycle.
          continue
        }
        const now = Date.now()
        const exitFee = config.feeSell ? takerFee(fill.fillPrice, fill.fillSize, config.feeRate) : 0
        const payout = fill.fillPrice * fill.fillSize - exitFee
        const pnl = payout - pos.cost
        db.closeTrade({ id, exitT: now, exitPrice: fill.fillPrice, exitReason: reason, exitFee, payout, pnl })
        swingCooldown.set(pos.windowKey, now)
        stats.settled += 1
        pendingClose.delete(id)
        log(
          `${mode.toUpperCase()} CLOSE ${reason} ${pos.coin}/${pos.timeframe} ${pos.side} @ ${fill.fillPrice.toFixed(3)} · ` +
            `pnl ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)}`,
        )
      }
    } catch (e) {
      log(`drainPendingCloses error — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      draining = false
    }
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

  // Open positions enriched with the live mark (current bid for the held side) so
  // the dashboard monitor can show unrealized P&L and time left in the window.
  function openPositions(): {
    coin: string
    timeframe: string
    side: 'up' | 'down'
    strategy: string
    entryPrice: number
    size: number
    mark: number | null
    unrealizedPnl: number | null
    msRemaining: number | null
  }[] {
    const now = Date.now()
    const live = new Map<string, ParsedMarket>()
    for (const s of scopes) if (s.market) live.set(marketWindowKey(s.market), s.market)
    return db.openTrades().map((t) => {
      const market = live.get(t.windowKey) ?? null
      const mark = market ? bidForSide(deriveBook(market), t.side) : null
      const endMs = market?.endDate.getTime() ?? windowEndMsFromKey(t.windowKey)
      return {
        coin: t.coin,
        timeframe: t.timeframe,
        side: t.side,
        strategy: t.strategy,
        entryPrice: t.entryPrice,
        size: t.size,
        mark,
        unrealizedPnl: mark != null ? mark * t.size - t.cost : null,
        msRemaining: endMs != null ? endMs - now : null,
      }
    })
  }

  function refreshMarket(state: ScopeState, now: number): void {
    const ended = state.market ? now >= state.market.endDate.getTime() : true
    if (state.fetching) return
    // Poll faster while this scope holds an open swing position so the exit marks
    // against a fresher book and the stop slips less past its target on a fast move.
    const hasOpen =
      config.strategy === 'swing' &&
      state.market != null &&
      db.openTradesForWindow(marketWindowKey(state.market)).length > 0
    const pollMs = hasOpen ? config.swingOpenPollMs : config.marketPollMs
    if (state.market && !ended && now - state.lastFetch < pollMs) return
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

    // Trade every tick (not throttled) so entries/exits land on time. Entries only
    // fire on tradable timeframes; recorded-but-not-traded ones (e.g. 5m) still log
    // predictions above but never enter. Swing exits are managed regardless.
    if (mode !== 'record') {
      const canEnter = tradeTf.has(state.timeframe)
      if (config.strategy === 'swing') {
        recordMid(pred, now)
        void manageSwing(pred, market, now, canEnter)
      } else if (config.strategy === 'maker') {
        manageMaker(pred, market, now, canEnter)
      } else if (canEnter) {
        void maybeTrade(pred, market, now)
      }
    }

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

  // Drop a finished window from all in-memory per-window state.
  const forget = (windowKey: string): void => {
    tracked.delete(windowKey)
    midHistory.delete(windowKey)
    swingCooldown.delete(windowKey)
  }

  // After a restart, in-memory `tracked` is empty — re-seed from open trades so
  // sweepOutcomes can still record outcomes and settleTrades can close orphans.
  function seedTrackedFromOpen(): void {
    for (const t of db.openTrades()) {
      if (tracked.has(t.windowKey)) continue
      const endMs = windowEndMsFromKey(t.windowKey)
      if (endMs == null) continue
      const pair = chainlinkPair(t.coin as CoinId)
      if (!pair) continue
      const strike = db.windowStrike(t.windowKey)
      if (strike == null) continue
      tracked.set(t.windowKey, {
        pair,
        coin: t.coin,
        timeframe: t.timeframe,
        strike,
        endMs,
      })
    }
  }

  function sweepOutcomes(now: number): void {
    for (const [windowKey, w] of tracked) {
      if (now <= w.endMs + 2_000) continue
      if (db.hasOutcome(windowKey)) {
        forget(windowKey)
        continue
      }
      let finalPrice =
        stream.firstPriceAtOrAfter(w.pair, w.endMs, OUTCOME_SLOP_MS) ??
        db.tickAtOrAfter(w.pair, w.endMs, OUTCOME_SLOP_MS)
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
        forget(windowKey)
      } else if (now > w.endMs + OUTCOME_GIVEUP_MS) {
        forget(windowKey) // boundary tick never arrived
      }
    }
  }

  // Maker live state for the dashboard monitor (only meaningful while strategy='maker').
  function makerStatus(): NonNullable<BotStatus['maker']> {
    const inventory = [...makerInv.entries()].map(([wk, inv]) => {
      const meta = makerMeta.get(wk)
      return {
        coin: meta?.coin ?? '?',
        timeframe: meta?.timeframe ?? '?',
        net: inv.upShares - inv.downShares,
        upShares: inv.upShares,
        downShares: inv.downShares,
      }
    })
    const quotes = makerExec.open().map((o) => {
      const meta = makerMeta.get(o.windowKey)
      return {
        coin: meta?.coin ?? '?',
        timeframe: meta?.timeframe ?? '?',
        side: o.side,
        price: o.price,
        size: o.size - o.filled,
      }
    })
    return {
      fillModel: config.makerFillModel,
      baseSpread: config.makerBaseSpread,
      clipUsd: config.makerClipUsd,
      maxInventory: config.makerMaxInventory,
      rebateRate: config.makerRebateRate,
      feedConnected: makerStream.connected,
      fills: stats.makerFills,
      openQuotes: quotes.length,
      inventory,
      quotes,
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
              stakeUsd: config.stakeUsd,
              usdcBalance: mode === 'live' ? cachedUsdcBalance : null,
              strategy: config.strategy,
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
              summary: db.tradeSummaryForMode(mode),
              dailyTrades: db.countTradesSince(Date.now() - 86_400_000),
              maxDailyTrades: effectiveDailyCap(),
              // Traded subset + the full recorded universe it can be toggled across.
              tradeTimeframes: config.timeframes.filter((tf) => tradeTf.has(tf)),
              availableTimeframes: config.timeframes.filter((tf) => recordedTf.has(tf)),
              // Positions still being force-closed at market (strategy switch retries).
              pendingCloses: pendingClose.size,
              swingExits: config.strategy === 'swing' ? db.swingExits() : [],
              swingTrigger: config.swingTrigger,
              swingSource: config.signalSource,
              openPositions: openPositions(),
              recentClosed: db.recentClosed(8, mode),
              maker: config.strategy === 'maker' ? makerStatus() : undefined,
            }),
            setMode,
            setHalted,
            setStakeUsd,
            setMaxDailyTrades,
            setStrategy,
            setTradeTimeframes,
            setMaker,
            getHistory: (query) => db.queryTrades(query),
          },
          Number(process.env.BOT_CONTROL_PORT ?? 8790),
          process.env.BOT_CONTROL_TOKEN?.trim() || undefined,
          log,
        )

  seedTrackedFromOpen()

  let lastStatus = 0
  let lastBalanceRefresh = 0
  const BALANCE_REFRESH_MS = 60_000
  const timer = setInterval(() => {
    const now = Date.now()
    // Maker: keep the CLOB feed subscribed to tradable tokens and advance the fill
    // sim BEFORE quoting happens inside sampleScope (fills update inventory first).
    if (mode !== 'record' && config.strategy === 'maker') {
      const ids: string[] = []
      for (const s of scopes) {
        if (!s.market || !tradeTf.has(s.timeframe)) continue
        if (s.market.upTokenId) ids.push(s.market.upTokenId)
        if (s.market.downTokenId) ids.push(s.market.downTokenId)
      }
      makerStream.setTokens(ids)
      makerStep(now)
    }
    for (const state of scopes) {
      refreshMarket(state, now)
      sampleScope(state, now)
    }
    seedTrackedFromOpen()
    sweepOutcomes(now)
    // Finalize maker windows regardless of the current strategy so a switch-away
    // still settles inventory once the boundary outcome lands.
    if (mode !== 'record') finalizeMakerWindows(now)
    if (mode !== 'record') settleTrades(now)
    // Retry any queued force-closes (strategy switch) whose book was empty/thin.
    if (mode !== 'record' && pendingClose.size > 0 && now - lastCloseDrain >= CLOSE_RETRY_MS) {
      lastCloseDrain = now
      void drainPendingCloses()
    }

    if (mode === 'live' && now - lastBalanceRefresh >= BALANCE_REFRESH_MS) {
      lastBalanceRefresh = now
      void import('../api/_lib/clob')
        .then(({ fetchUsdcBalance }) => fetchUsdcBalance())
        .then((b) => {
          cachedUsdcBalance = b
        })
        .catch(() => {})
    }

    if (now - lastStatus >= STATUS_MS) {
      lastStatus = now
      const live = scopes.filter((s) => s.market).length
      const dailyTrades = db.countTradesSince(now - 86_400_000)
      const cap = effectiveDailyCap()
      const dailyCap = mode !== 'record' && cap > 0 && dailyTrades >= cap
      const makerBrief =
        config.strategy === 'maker' && mode !== 'record'
          ? ` · maker[cw=${makerStream.connected ? 'up' : 'down'} quotes=${makerExec.open().length}` +
            ` fills=${stats.makerFills} invWin=${makerInv.size}]`
          : ''
      log(
        `[${mode}] ws=${stream.connected ? 'up' : 'down'} · live=${live}/${scopes.length} · ` +
          `ticks=${stats.ticks} preds=${stats.predictions} outcomes=${stats.outcomes}` +
          (mode !== 'record'
            ? ` · trades=${stats.trades} settled=${stats.settled} open=${db.countOpenTrades()}` +
              ` · daily ${dailyTrades}/${cap || '∞'}${dailyCap ? ' CAP' : ''}`
            : '') +
          makerBrief +
          ` · pending=${tracked.size}`,
      )
    }
  }, config.tickMs)

  const shutdown = (): void => {
    clearInterval(timer)
    controlServer?.close()
    stream.stop()
    makerStream.stop()
    db.close()
    log(`${mode} stopped`)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main()
