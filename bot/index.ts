/**
 * Bot entry. Streams Chainlink ticks + gamma odds for every in-scope market,
 * logs flat+regime predictions and outcomes to SQLite, and (dry/live) trades value
 * entries (model edge on the cheap side, hold to settlement). Mode is runtime-switchable
 *   record → log only · dry → paper-trade · live → real FAK orders (gated)
 */
import '../api/_lib/loadEnv' // side effect: load .env.local (POLY_* for live, BOT_* overrides)
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { activeScopes, loadConfig, type BotConfig } from './config'
import { openDb } from './db'
import { loadRuntimeSettings, saveRuntimeSettings } from './runtime'
import { ChainlinkStream } from './sources/chainlink'
import { fetchCurrentMarket, fetchMarketByEventSlug } from './sources/gamma'
import { fetchWindowOutcome } from './sources/resolveOutcome'
import { fetchRedeemableByToken, redeemEnvHint, redeemWinningPosition } from './sources/redeem'
import { fetchClobBestAsk, fetchClobBestBid } from './sources/clobBook'
import { fetchPolyPositionsByToken, type PolyPositionSnap } from './sources/polyPositions'
import { normalizeLiveFill, settlementPayout, tradeShares } from './tradeFill'
import { predict, type Prediction } from './engine/predict'
import { decideEntry, entryBlockReason } from './engine/strategy'
import { decideSwingEntry, decideExit, deriveBook, bidForSide, sourceEdge, type MidPoint } from './engine/swing'
import { decideValueExit } from './engine/valueExit'
import { decideCertaintyExit } from './engine/certaintyExit'
import {
  certaintyBlockReason,
  certaintyStrike,
  evaluateCertainty,
  inCertaintyEntryBand,
  oracleFavoredSide,
  orderFromCertainty,
  pickCertaintyCandidates,
  certaintyEntryRecord,
  formatCertaintyConfig,
  type CertaintyCandidate,
  type CertaintyEvalOpts,
} from './engine/certainty'
import { takerFee } from './engine/fees'
import {
  dryExecutor,
  isGoneOutcomeTokenError,
  isInsufficientBalanceError,
  makeLiveExecutor,
  type SellOrder,
} from './engine/executor'
import { ClobMarketStream, type TradePrint } from './sources/clobMarket'
import { MakerSimExecutor, type MakerFill, type MakerQuote } from './engine/makerExecutor'
import { decideQuotes, type MakerContext, type MakerInventory } from './engine/maker'
import { emptyAccount, applyFill, flatten as flattenAccount, settle as settleAccount } from './engine/makerAccount'
import { maxOrderCost, tradingEnabled } from './engine/guards'
import { getPolyConfig } from '../api/_lib/env'
import { startControlServer, type BotMode, type BotStatus } from './control'
import { VOL_LOOKBACK_MS } from '../src/lib/fairValue'
import { marketWindowKey, parseMarketWindowKey, windowEndMsFromKey } from '../src/lib/marketScope'
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
  if (runtime.certainty) {
    const rc = runtime.certainty
    if (rc.entryWithinSec != null && rc.entryWithinSec >= 5 && rc.entryWithinSec <= 120) {
      config.certaintyEntryWithinSec = rc.entryWithinSec
    }
    if (rc.minWinProb != null && rc.minWinProb > 0.5 && rc.minWinProb < 1) {
      config.certaintyMinWinProb = rc.minWinProb
    }
    if (rc.minEdge != null && rc.minEdge >= 0.01 && rc.minEdge <= 0.2) {
      config.certaintyMinEdge = rc.minEdge
    }
    if (rc.maxAsk != null && rc.maxAsk > 0.5 && rc.maxAsk < 1) {
      config.certaintyMaxAsk = rc.maxAsk
    }
    if (
      rc.maxCoins != null &&
      Number.isInteger(rc.maxCoins) &&
      rc.maxCoins >= 1 &&
      rc.maxCoins <= 6
    ) {
      config.certaintyMaxCoins = rc.maxCoins
      if (config.certaintyMinCoins > rc.maxCoins) config.certaintyMinCoins = rc.maxCoins
    }
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
  const repaired = db.repairLiveTradeFills(config.stakeUsd)
  if (repaired > 0) log(`repaired ${repaired} live trade fill(s) in trade history`)
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
  /** Windows successfully entered this session (per mode — dry paper does not block live). */
  const entered = new Set<string>()
  const enteredKey = (windowKey: string): string => `${mode}:${windowKey}`
  /** In-flight value-entry guard — mirrors enteringSwing so a slow buy can't double-fire. */
  const enteringValue = new Set<string>()
  /** In-flight certainty-entry guard — one slow buy must not double-fire per window. */
  const enteringCertainty = new Set<string>()
  /** Per-tick candidates collected across scopes; cleared after pickAndTradeCertainty. */
  /** In-flight certainty redeem guard — one relayer tx per position at a time. */
  const certaintyRedeeming = new Set<number>()
  const certaintyRedeemAfter = new Map<number, number>()
  let lastCertaintyCashSweep = 0
  const CERTAINTY_CASH_SWEEP_MS = 5_000
  const CERTAINTY_REDEEM_RETRY_MS = 30_000

  let certaintyCandidates: CertaintyCandidate[] = []
  /** Markets + marks for open positions whose windows have rolled off the live scope list. */
  const openMarketCache = new Map<string, ParsedMarket>()
  const openMarkCache = new Map<string, number | null>()
  const openPolyCache = new Map<string, PolyPositionSnap>()
  /** Polymarket crypto-price API resolution — overrides stale Chainlink outcomes. */
  const polyOutcomeCache = new Map<string, 'up' | 'down'>()
  let lastOutcomeRepair = 0
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
  /** Windows currently being resolved via the Polymarket crypto-price API. */
  const outcomeResolving = new Set<string>()
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
        : config.strategy === 'certainty'
          ? `certainty · T-${config.certaintyEntryWithinSec}s · P≥${config.certaintyMinWinProb} · edge≥${config.certaintyMinEdge}` +
            ` · ask ${(config.certaintyMinFavoredAsk * 100).toFixed(0)}–${(config.certaintyMaxAsk * 100).toFixed(0)}¢ · z≥${config.certaintyMinZ} · pick ${config.certaintyMinCoins}-${config.certaintyMaxCoins}` +
            ` · sell≥${(config.certaintyTakeProfitBid * 100).toFixed(0)}¢` +
            ` · src ${config.signalSource}`
          : `value · edge≥${config.edgeThreshold} · ask≤${config.valueMaxEntryPrice}` +
            (config.valueExitEnabled
              ? ` · exit P<${config.valueExitMinWinProb} @${config.valueExitWithinSec}s`
              : ' · exit off')
  log(
    `${mode} up · db=${config.dbPath} · scopes=${scopes.map((s) => `${s.coin}/${s.timeframe}`).join(',')}` +
      (mode !== 'record'
        ? ` · trade[${config.timeframes.filter((tf) => tradeTf.has(tf)).join(',') || 'none'}] · ${strategyBrief} · $${config.stakeUsd}`
        : ''),
  )
  if (mode === 'live' && config.strategy === 'certainty') {
    const redeemHint = redeemEnvHint()
    if (redeemHint) log(`NOTE: ${redeemHint}`)
  }

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

  function setStrategy(next: BotConfig['strategy']): { ok: boolean; error?: string } {
    if (next !== 'value' && next !== 'swing' && next !== 'maker' && next !== 'certainty') {
      return { ok: false, error: 'strategy must be value|swing|maker|certainty' }
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

  function setCertainty(patch: {
    entryWithinSec?: number
    minWinProb?: number
    minEdge?: number
    maxAsk?: number
    maxCoins?: number
  }): { ok: boolean; error?: string } {
    const applied: string[] = []
    const persist: NonNullable<typeof runtime.certainty> = { ...runtime.certainty }

    if (patch.entryWithinSec != null) {
      if (!Number.isInteger(patch.entryWithinSec) || patch.entryWithinSec < 5 || patch.entryWithinSec > 120) {
        return { ok: false, error: 'entry window must be 5–120 seconds' }
      }
      config.certaintyEntryWithinSec = patch.entryWithinSec
      persist.entryWithinSec = patch.entryWithinSec
      applied.push(`T-${patch.entryWithinSec}s`)
    }
    if (patch.minWinProb != null) {
      if (!(patch.minWinProb > 0.5 && patch.minWinProb < 0.999)) {
        return { ok: false, error: 'min P(win) must be between 50% and 99.9%' }
      }
      config.certaintyMinWinProb = patch.minWinProb
      persist.minWinProb = patch.minWinProb
      applied.push(`P≥${patch.minWinProb.toFixed(2)}`)
    }
    if (patch.minEdge != null) {
      if (!(patch.minEdge >= 0.01 && patch.minEdge <= 0.2)) {
        return { ok: false, error: 'min edge must be 1–20¢' }
      }
      config.certaintyMinEdge = patch.minEdge
      persist.minEdge = patch.minEdge
      applied.push(`edge≥${patch.minEdge.toFixed(2)}`)
    }
    if (patch.maxAsk != null) {
      if (!(patch.maxAsk > 0.5 && patch.maxAsk < 0.999)) {
        return { ok: false, error: 'max ask must be between 50¢ and 99.9¢' }
      }
      config.certaintyMaxAsk = patch.maxAsk
      persist.maxAsk = patch.maxAsk
      applied.push(`ask≤${patch.maxAsk.toFixed(2)}`)
    }
    if (patch.maxCoins != null) {
      if (!Number.isInteger(patch.maxCoins) || patch.maxCoins < 1 || patch.maxCoins > 6) {
        return { ok: false, error: 'max coins must be 1–6' }
      }
      config.certaintyMaxCoins = patch.maxCoins
      if (config.certaintyMinCoins > patch.maxCoins) config.certaintyMinCoins = patch.maxCoins
      persist.maxCoins = patch.maxCoins
      applied.push(`max ${patch.maxCoins} coins`)
    }

    if (applied.length === 0) return { ok: false, error: 'no certainty fields to update' }
    runtime.certainty = persist
    saveRuntimeSettings(RUNTIME_PATH, { certainty: persist })
    log(`certainty config → ${applied.join(' · ')} (control)`)
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
    return db.countTradesSince(now - 86_400_000, mode) >= cap
  }

  /** Normalize live CLOB fills before persisting — guards against absurd parse glitches. */
  function liveFillAmounts(
    order: { fillPrice: number; stakeUsd: number },
    fill: { fillPrice: number; fillSize: number },
  ): { entryPrice: number; size: number; cost: number } | null {
    if (mode !== 'live') {
      const cost = fill.fillPrice * fill.fillSize
      return { entryPrice: fill.fillPrice, size: fill.fillSize, cost }
    }
    return normalizeLiveFill(order.stakeUsd, order.fillPrice, fill.fillPrice, fill.fillSize)
  }

  // Value entry: once per window when edge clears and the ask is cheap enough.
  // Dry paper-fills; live places a real FAK BUY. Retries a few times with backoff
  // after NO FILL so an empty book isn't hammered every tick.
  async function maybeTrade(pred: Prediction, market: ParsedMarket, now: number): Promise<void> {
    if (entriesHalted(now)) return
    if (entered.has(enteredKey(pred.windowKey)) || db.tradeExists(pred.windowKey, mode)) return
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

    const amounts = liveFillAmounts(order, fill)
    if (!amounts) {
      log(
        `${mode.toUpperCase()} NO FILL ${pred.coin}/${pred.timeframe} ${order.side} @ ${order.fillPrice.toFixed(3)} · ` +
          `$${order.stakeUsd} · ${secLeft}s left — bad fill parse` +
          (attempt < ENTRY_MAX_ATTEMPTS ? ` (retry in ${ENTRY_NO_FILL_BACKOFF_MS / 1000}s)` : ' (max attempts)'),
      )
      if (attempt < ENTRY_MAX_ATTEMPTS) entryRetryAfter.set(pred.windowKey, now + ENTRY_NO_FILL_BACKOFF_MS)
      return
    }
    const { entryPrice, size, cost } = amounts
    if (mode === 'live' && cost < order.stakeUsd * 0.9) {
      log(
        `${mode.toUpperCase()} NO FILL ${pred.coin}/${pred.timeframe} ${order.side} ` +
          `(dust fill $${cost.toFixed(4)} on $${order.stakeUsd} order — not recording)`,
      )
      return
    }
    entered.add(enteredKey(pred.windowKey))
    if (mode === 'live') cachedUsdcBalance = cachedUsdcBalance == null ? null : cachedUsdcBalance - cost
    db.insertTrade({
      windowKey: pred.windowKey,
      coin: pred.coin,
      timeframe: pred.timeframe,
      mode,
      strategy: 'value',
      side: order.side,
      entryT: now,
      entryPrice,
      size,
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

  async function executeCertaintyEntry(candidate: CertaintyCandidate, now: number): Promise<void> {
    let active = candidate
    if (mode === 'live') {
      const fresh = await revalidateCertaintyCandidate(candidate, now)
      if (!fresh) {
        const { pred, market } = candidate
        log(
          `${mode.toUpperCase()} SKIP certainty ${pred.coin}/${pred.timeframe} — pre-buy re-check failed · ` +
            `${Math.round((market.endDate.getTime() - now) / 1000)}s left`,
        )
        return
      }
      active = fresh
    }
    const { pred, market, eval: ev } = active
    const windowKey = pred.windowKey
    const msRemaining = market.endDate.getTime() - now
    if (entriesHalted(now)) return
    if (entered.has(enteredKey(windowKey)) || db.tradeExists(windowKey, mode)) return
    if (enteringCertainty.has(windowKey)) return
    if ((balanceBlockedUntil.get(windowKey) ?? 0) > now) return
    if ((entryRetryAfter.get(windowKey) ?? 0) > now) return
    if (!inCertaintyEntryBand(msRemaining, config)) return
    if (db.countOpenTrades() >= config.maxConcurrent) return
    if (dailyCapReached(now)) return

    const order = orderFromCertainty(active, config)
    const secLeft = Math.round(msRemaining / 1000)
    const attempt = (entryAttemptCount.get(windowKey) ?? 0) + 1
    entryAttemptCount.set(windowKey, attempt)
    log(
      `${mode.toUpperCase()} ATTEMPT certainty ${pred.coin}/${pred.timeframe} ${order.side} @ ${order.fillPrice.toFixed(3)} · ` +
        `$${order.stakeUsd} · P ${ev.pWin.toFixed(3)} · edge ${ev.edge.toFixed(3)} · z ${ev.zDist.toFixed(2)} · ` +
        `${secLeft}s left · try ${attempt} (T-band)`,
    )

    enteringCertainty.add(windowKey)
    let fill
    try {
      fill = await executor.buy(order)
    } catch (e) {
      enteringCertainty.delete(windowKey)
      const msg = e instanceof Error ? e.message : String(e)
      if (isInsufficientBalanceError(msg)) {
        balanceBlockedUntil.set(windowKey, now + 30_000)
        log(
          `${mode.toUpperCase()} SKIP certainty ${pred.coin}/${pred.timeframe} ${order.side} — ${msg} ` +
            `(deposit or lower stake; pausing retries 30s)`,
        )
        return
      }
      log(
        `${mode.toUpperCase()} ORDER FAILED certainty ${pred.coin}/${pred.timeframe} ${order.side} @ ${order.fillPrice.toFixed(3)} · ` +
          `$${order.stakeUsd} · ${secLeft}s left — ${msg}` +
          (inCertaintyEntryBand(market.endDate.getTime() - now, config)
            ? ` (retry in ${config.certaintyEntryRetryMs / 1000}s)`
            : ''),
      )
      if (inCertaintyEntryBand(market.endDate.getTime() - now, config)) {
        entryRetryAfter.set(windowKey, now + config.certaintyEntryRetryMs)
      }
      return
    }
    enteringCertainty.delete(windowKey)
    if (!(fill.fillSize > 0 && fill.fillPrice > 0)) {
      log(
        `${mode.toUpperCase()} NO FILL certainty ${pred.coin}/${pred.timeframe} ${order.side} @ ${order.fillPrice.toFixed(3)} · ` +
          `$${order.stakeUsd} · ${secLeft}s left — book empty / FAK killed` +
          (inCertaintyEntryBand(market.endDate.getTime() - now, config)
            ? ` (retry in ${config.certaintyEntryRetryMs / 1000}s)`
            : ''),
      )
      if (inCertaintyEntryBand(market.endDate.getTime() - now, config)) {
        entryRetryAfter.set(windowKey, now + config.certaintyEntryRetryMs)
      }
      return
    }

    const amounts = liveFillAmounts(order, fill)
    if (!amounts) {
      log(
        `${mode.toUpperCase()} NO FILL certainty ${pred.coin}/${pred.timeframe} ${order.side} @ ${order.fillPrice.toFixed(3)} · ` +
          `$${order.stakeUsd} · ${secLeft}s left — bad fill parse` +
          (inCertaintyEntryBand(market.endDate.getTime() - now, config)
            ? ` (retry in ${config.certaintyEntryRetryMs / 1000}s)`
            : ''),
      )
      if (inCertaintyEntryBand(market.endDate.getTime() - now, config)) {
        entryRetryAfter.set(windowKey, now + config.certaintyEntryRetryMs)
      }
      return
    }
    const { entryPrice, size, cost } = amounts
    if (mode === 'live' && cost < order.stakeUsd * 0.9) {
      log(
        `${mode.toUpperCase()} NO FILL certainty ${pred.coin}/${pred.timeframe} ${order.side} ` +
          `(dust fill $${cost.toFixed(4)} on $${order.stakeUsd} order — not recording)`,
      )
      return
    }
    entered.add(enteredKey(windowKey))
    if (mode === 'live') cachedUsdcBalance = cachedUsdcBalance == null ? null : cachedUsdcBalance - cost
    const snap = certaintyEntryRecord(ev, pred, config)
    db.insertTrade({
      windowKey,
      coin: pred.coin,
      timeframe: pred.timeframe,
      mode,
      strategy: 'certainty',
      side: order.side,
      entryT: now,
      entryPrice,
      size,
      cost,
      entryFee: 0,
      signalEdge: ev.edge,
      regimeEntry: pred.regime,
      status: 'open',
      orderId: fill.orderId,
      certainty: snap,
    })
    stats.trades += 1
    log(
      `${mode.toUpperCase()} ENTER certainty ${pred.coin}/${pred.timeframe} ${order.side} @ ${entryPrice.toFixed(3)} · ` +
        `size ${size.toFixed(1)} · cost $${cost.toFixed(2)} · P ${ev.pWin.toFixed(3)} · edge ${ev.edge.toFixed(3)} · ` +
        `z ${ev.zDist.toFixed(2)} · ${secLeft}s left · ${formatCertaintyConfig(snap)}` +
        (fill.orderId ? ` · ${fill.orderId.slice(0, 10)}` : ''),
    )
  }

  /** Rank cross-scope candidates and enter up to certaintyMaxCoins this tick. */
  async function pickAndTradeCertainty(candidates: CertaintyCandidate[], now: number): Promise<void> {
    if (entriesHalted(now)) return
    const picked = pickCertaintyCandidates(candidates, config)
    if (picked.length === 0) return
    for (const c of picked) {
      if (db.countOpenTrades() >= config.maxConcurrent) break
      if (dailyCapReached(now)) break
      await executeCertaintyEntry(c, now)
    }
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

  type SellExitResult = 'closed' | 'retry' | 'gone'

  /** Market-sell an open position; returns how the attempt resolved. */
  async function marketSellExit(
    pos: { id: number; side: 'up' | 'down'; size: number; cost: number },
    pred: Prediction,
    market: ParsedMarket,
    now: number,
    exit: { reason: string; mark: number },
    logPrefix: string,
  ): Promise<SellExitResult> {
    if (exitingTrades.has(pos.id)) return 'retry'
    const tokenId = pos.side === 'up' ? market.upTokenId : market.downTokenId
    if (!tokenId) return 'retry'
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
      const msg = e instanceof Error ? e.message : String(e)
      if (isGoneOutcomeTokenError(msg)) return 'gone'
      log(`${mode.toUpperCase()} SELL FAILED #${pos.id} ${pos.side} — ${msg} (will retry)`)
      return 'retry'
    }
    exitingTrades.delete(pos.id)
    if (!(fill.fillSize > 0 && fill.fillPrice > 0)) return 'retry'

    const exitFee = config.feeSell ? takerFee(fill.fillPrice, fill.fillSize, config.feeRate) : 0
    const payout = fill.fillPrice * fill.fillSize - exitFee
    const pnl = payout - pos.cost
    db.closeTrade({
      id: pos.id,
      exitT: now,
      exitPrice: fill.fillPrice,
      exitReason: exit.reason,
      exitFee,
      payout,
      pnl,
    })
    stats.settled += 1
    log(
      `${mode.toUpperCase()} EXIT ${exit.reason} ${logPrefix}${pred.coin}/${pred.timeframe} ${pos.side} @ ${fill.fillPrice.toFixed(3)} · ` +
        `pnl ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)} · ${Math.round((market.endDate.getTime() - now) / 1000)}s left`,
    )
    if (mode === 'live' && cachedUsdcBalance != null) cachedUsdcBalance += payout
    return 'closed'
  }

  function closeCertaintyAsRecovered(
    pos: {
      id: number
      coin: string
      timeframe: string
      side: 'up' | 'down'
      size: number
      cost: number
      entryPrice: number
    },
    now: number,
    note = 'already recovered',
  ): void {
    const payout = tradeShares(pos)
    const pnl = payout - pos.cost
    db.closeTrade({
      id: pos.id,
      exitT: now,
      exitPrice: 1,
      exitReason: 'redeem',
      exitFee: 0,
      payout,
      pnl,
    })
    if (cachedUsdcBalance != null) cachedUsdcBalance += payout
    stats.settled += 1
    log(
      `${mode.toUpperCase()} REDEEM certainty ${pos.coin}/${pos.timeframe} ${pos.side} · ` +
        `pnl ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)} (${note})`,
    )
  }

  function certaintyTokensGone(
    tokenId: string | null | undefined,
    polyByToken: Map<string, PolyPositionSnap> | null,
  ): boolean {
    if (!tokenId || !polyByToken) return false
    const snap = polyByToken.get(tokenId)
    return !snap || snap.currentValue <= 0.01
  }

  async function swingExit(pred: Prediction, market: ParsedMarket, now: number): Promise<void> {
    for (const pos of db.openTradesForWindow(pred.windowKey)) {
      if (pos.strategy !== 'swing' || exitingTrades.has(pos.id)) continue
      const exit = decideExit(pos, pred, market, config, now)
      if (!exit) continue
      const result = await marketSellExit(pos, pred, market, now, exit, '')
      if (result === 'closed') swingCooldown.set(pred.windowKey, now)
    }
  }

  async function valueExit(pred: Prediction, market: ParsedMarket, now: number): Promise<void> {
    for (const pos of db.openTradesForWindow(pred.windowKey)) {
      if (pos.strategy !== 'value' || exitingTrades.has(pos.id)) continue
      const exit = decideValueExit(pos, pred, market, config, now, pos.entryT)
      if (!exit) continue
      await marketSellExit(pos, pred, market, now, exit, 'value ')
    }
  }

  async function certaintyExit(pred: Prediction, market: ParsedMarket, now: number): Promise<void> {
    for (const pos of db.openTradesForWindow(pred.windowKey)) {
      if (pos.strategy !== 'certainty' || exitingTrades.has(pos.id)) continue
      const exit = decideCertaintyExit(pos, market, config, now)
      if (!exit) continue
      await marketSellExit(pos, pred, market, now, exit, 'certainty ')
    }
  }

  /** Post-window USDC recovery — sell into any bid, then redeem on live when flagged. */
  async function tryCertaintyRedeem(
    pos: {
      id: number
      windowKey: string
      coin: string
      timeframe: string
      side: 'up' | 'down'
      size: number
      cost: number
      entryPrice: number
    },
    market: ParsedMarket,
    now: number,
  ): Promise<boolean> {
    if (mode !== 'live') return false
    if (certaintyRedeeming.has(pos.id)) return false
    if ((certaintyRedeemAfter.get(pos.id) ?? 0) > now) return false
    certaintyRedeemAfter.set(pos.id, now + CERTAINTY_REDEEM_RETRY_MS)

    const poly = getPolyConfig()
    if (!poly) return false
    const tokenId = pos.side === 'up' ? market.upTokenId : market.downTokenId
    if (!tokenId) return false

    let redeemable = false
    try {
      const byToken = await fetchRedeemableByToken(poly.funderAddress)
      redeemable = byToken.get(tokenId)?.redeemable === true
    } catch {
      return false
    }
    if (!redeemable) {
      try {
        const positions = await fetchPolyPositionsByToken(poly.funderAddress)
        const snap = positions.get(tokenId)
        if (!snap || snap.currentValue <= 0.01) {
          closeCertaintyAsRecovered(pos, now)
          return true
        }
      } catch {
        return false
      }
      return false
    }

    const parsed = parseMarketWindowKey(pos.windowKey)
    if (!parsed) return false

    certaintyRedeeming.add(pos.id)
    const shares = tradeShares(pos)
    const result = await redeemWinningPosition({
      eventSlug: parsed.eventSlug,
      side: pos.side,
      size: shares,
      negRisk: market.negRisk === true,
    })
    certaintyRedeeming.delete(pos.id)
    if (!result.ok) {
      log(
        `${mode.toUpperCase()} REDEEM FAILED #${pos.id} ${pos.coin}/${pos.timeframe} ${pos.side} — ${result.error ?? 'unknown'}`,
      )
      return false
    }

    const payout = shares
    const pnl = payout - pos.cost
    db.closeTrade({
      id: pos.id,
      exitT: now,
      exitPrice: 1,
      exitReason: 'redeem',
      exitFee: 0,
      payout,
      pnl,
    })
    if (cachedUsdcBalance != null) cachedUsdcBalance += payout
    stats.settled += 1
    log(
      `${mode.toUpperCase()} REDEEM certainty ${pos.coin}/${pos.timeframe} ${pos.side} · ` +
        `pnl ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)}`,
    )
    return true
  }

  async function sweepCertaintyCash(now: number): Promise<void> {
    if (mode === 'record') return
    const open = db.openTrades().filter((t) => t.strategy === 'certainty')
    if (open.length === 0) return

    const liveMarkets = new Map<string, ParsedMarket>()
    for (const s of scopes) if (s.market) liveMarkets.set(marketWindowKey(s.market), s.market)

    let polyByToken: Map<string, PolyPositionSnap> | null = null
    if (mode === 'live') {
      const poly = getPolyConfig()
      if (poly) {
        try {
          polyByToken = await fetchPolyPositionsByToken(poly.funderAddress)
        } catch {
          polyByToken = null
        }
      }
    }

    for (const pos of open) {
      if (exitingTrades.has(pos.id) || certaintyRedeeming.has(pos.id)) continue
      const endMs = windowEndMsFromKey(pos.windowKey)
      if (endMs == null || now <= endMs + 2_000) continue

      const outcome = db.outcomeFor(pos.windowKey)
      if (outcome && pos.side !== outcome) continue // loser — settleTrades closes the book row

      let market = liveMarkets.get(pos.windowKey) ?? null
      if (!market) {
        const parsed = parseMarketWindowKey(pos.windowKey)
        if (parsed) {
          market = await fetchMarketByEventSlug(
            parsed.eventSlug,
            pos.coin as CoinId,
            pos.timeframe as TimeframeId,
          )
        }
      }
      if (!market) continue

      const tokenId = pos.side === 'up' ? market.upTokenId : market.downTokenId
      if (mode === 'live' && outcome && pos.side === outcome && certaintyTokensGone(tokenId, polyByToken)) {
        closeCertaintyAsRecovered(pos, now)
        continue
      }

      const stubPred = {
        windowKey: pos.windowKey,
        coin: pos.coin as CoinId,
        timeframe: pos.timeframe as TimeframeId,
      } as Prediction

      let windowEndMark = bidForSide(deriveBook(market), pos.side)
      if (mode === 'live') {
        if (tokenId) {
          const clobBid = await fetchClobBestBid(tokenId)
          if (clobBid != null) windowEndMark = clobBid
        }
      }
      const exit =
        windowEndMark != null && windowEndMark >= config.certaintyWindowEndMinBid
          ? { reason: 'window-end' as const, mark: windowEndMark }
          : null
      if (exit) {
        const result = await marketSellExit(pos, stubPred, market, now, exit, 'certainty ')
        if (result === 'closed') continue
        if (result === 'gone' && outcome && pos.side === outcome) {
          closeCertaintyAsRecovered(pos, now, 'tokens gone')
          continue
        }
      }

      if (outcome && pos.side === outcome) {
        await tryCertaintyRedeem(pos, market, now)
      }
    }
  }

  async function certaintyClobAsks(
    market: ParsedMarket,
    side: 'up' | 'down',
  ): Promise<{ clobAsk: number | null; clobOppAsk: number | null }> {
    const favoredId = side === 'up' ? market.upTokenId : market.downTokenId
    const oppId = side === 'up' ? market.downTokenId : market.upTokenId
    const [clobAsk, clobOppAsk] = await Promise.all([
      favoredId ? fetchClobBestAsk(favoredId) : Promise.resolve(null),
      oppId ? fetchClobBestAsk(oppId) : Promise.resolve(null),
    ])
    return { clobAsk, clobOppAsk }
  }

  async function certaintyEvalOpts(
    market: ParsedMarket,
    spot: number,
    strike: number,
    now: number,
  ): Promise<CertaintyEvalOpts | undefined> {
    if (!inCertaintyEntryBand(market.endDate.getTime() - now, config)) return undefined
    if (mode !== 'live') return undefined
    const side = oracleFavoredSide(spot, strike)
    const { clobAsk, clobOppAsk } = await certaintyClobAsks(market, side)
    return { clobAsk, clobOppAsk, requireClobAsk: true }
  }

  /** Fresh spot/strike/book check immediately before a live Easy buy. */
  async function revalidateCertaintyCandidate(
    candidate: CertaintyCandidate,
    now: number,
  ): Promise<CertaintyCandidate | null> {
    const { pred, market } = candidate
    const pair = chainlinkPair(pred.coin as CoinId)
    if (!pair) return null
    const windowStart = market.startDate?.getTime()
    const chainlinkOpen =
      windowStart != null ? stream.firstPriceAtOrAfter(pair, windowStart, 90_000) : null
    const strike = certaintyStrike(market, chainlinkOpen)
    const spot = stream.latest(pair)?.value ?? null
    if (strike == null || spot == null) return null
    const ticks = stream.ticksSince(pair, now - VOL_LOOKBACK_MS[pred.timeframe as TimeframeId])
    const freshPred = predict(market, ticks, strike, spot, now)
    if (!freshPred) return null
    const evalOpts = await certaintyEvalOpts(market, spot, strike, now)
    const ev = evaluateCertainty(freshPred, market, spot, strike, config, now, evalOpts)
    if (!ev.ok) return null
    return { pred: freshPred, market, eval: ev }
  }

  async function manageCertainty(
    pred: Prediction,
    market: ParsedMarket,
    spot: number,
    strike: number,
    now: number,
    canEnter: boolean,
  ): Promise<void> {
    await certaintyExit(pred, market, now)
    if (!canEnter) return
    const evalOpts = await certaintyEvalOpts(market, spot, strike, now)
    const ev = evaluateCertainty(pred, market, spot, strike, config, now, evalOpts)
    if (ev.ok) {
      certaintyCandidates.push({ pred, market, eval: ev })
      return
    }
    const block = ev.reason ?? certaintyBlockReason(pred, market, spot, strike, config, now, evalOpts)
    if (block) {
      const key = `${pred.windowKey}:${block}`
      if (!entrySkipLogged.has(key)) {
        entrySkipLogged.add(key)
        log(
          `${mode.toUpperCase()} SKIP certainty ${pred.coin}/${pred.timeframe} — ${block} · ` +
            `${Math.round((market.endDate.getTime() - now) / 1000)}s left`,
        )
      }
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
    const amounts = liveFillAmounts(order, fill)
    if (!amounts) return
    const { entryPrice, size, cost: fillCost } = amounts
    const entryFee = takerFee(entryPrice, size, config.feeRate)
    const cost = fillCost + entryFee
    if (mode === 'live' && fillCost < order.stakeUsd * 0.9) {
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
      entryPrice,
      size,
      cost,
      entryFee,
      signalEdge,
      regimeEntry: pred.regime,
      status: 'open',
      orderId: fill.orderId,
    })
    stats.trades += 1
    log(
      `${mode.toUpperCase()} ENTER swing/${config.swingTrigger} ${pred.coin}/${pred.timeframe} ${order.side} @ ${entryPrice.toFixed(3)} · ` +
        `size ${size.toFixed(1)} · cost $${cost.toFixed(2)} · edge ${signalEdge.toFixed(3)} (${config.signalSource}) · ${pred.regime} · ` +
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

  /** Value entries + statistical cut-loss exits (same exit-before-entry ordering). */
  async function manageValue(
    pred: Prediction,
    market: ParsedMarket,
    now: number,
    canEnter: boolean,
  ): Promise<void> {
    await valueExit(pred, market, now)
    if (canEnter) await maybeTrade(pred, market, now)
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
      // Live Easy winners stay open until sell/redeem actually returns USDC.
      if (mode === 'live' && won && s.strategy === 'certainty') continue
      const { payout, pnl } = settlementPayout(s, s.outcome)
      db.settleTrade(s.id, now, payout, pnl)
      stats.settled += 1
      log(`${mode.toUpperCase()} SETTLE ${s.side} ${won ? 'WIN ' : 'loss'} · pnl ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)}`)
    }
  }

  async function refreshOpenMarkets(): Promise<void> {
    if (mode === 'record') return
    const scopeMarkets = new Map<string, ParsedMarket>()
    for (const s of scopes) {
      if (s.market) scopeMarkets.set(marketWindowKey(s.market), s.market)
    }
    const open = db.openTrades().filter((t) => t.mode === mode)
    const openKeys = new Set(open.map((t) => t.windowKey))
    for (const key of openMarketCache.keys()) {
      if (!openKeys.has(key)) {
        openMarketCache.delete(key)
        openMarkCache.delete(key)
        openPolyCache.delete(key)
        polyOutcomeCache.delete(key)
      }
    }

    let polyByToken: Map<string, PolyPositionSnap> | null = null
    if (mode === 'live') {
      const poly = getPolyConfig()
      if (poly) {
        try {
          polyByToken = await fetchPolyPositionsByToken(poly.funderAddress)
        } catch {
          polyByToken = null
        }
      }
    }

    for (const pos of open) {
      let market = scopeMarkets.get(pos.windowKey) ?? openMarketCache.get(pos.windowKey) ?? null
      if (!market) {
        const parsed = parseMarketWindowKey(pos.windowKey)
        if (parsed) {
          market = await fetchMarketByEventSlug(
            parsed.eventSlug,
            pos.coin as CoinId,
            pos.timeframe as TimeframeId,
          )
        }
      }
      if (!market) continue
      openMarketCache.set(pos.windowKey, market)
      const tokenId = pos.side === 'up' ? market.upTokenId : market.downTokenId
      const poly = tokenId ? polyByToken?.get(tokenId) : undefined
      if (poly) {
        openPolyCache.set(pos.windowKey, poly)
        openMarkCache.set(pos.windowKey, poly.curPrice)
        continue
      }
      let mark: number | null = null
      if (mode === 'live' && tokenId) {
        mark = await fetchClobBestBid(tokenId)
      }
      if (mark == null) mark = bidForSide(deriveBook(market), pos.side)
      openMarkCache.set(pos.windowKey, mark)
    }

    if (mode === 'live' && Date.now() - lastOutcomeRepair > 30_000) {
      lastOutcomeRepair = Date.now()
      void repairOpenOutcomesFromPoly()
    }
    await reconcileGhostOpenPositions(polyByToken)
  }

  /** Close book rows for ended windows whose tokens no longer appear on Polymarket. */
  async function reconcileGhostOpenPositions(
    polyByToken: Map<string, PolyPositionSnap> | null,
  ): Promise<void> {
    if (mode !== 'live' || !polyByToken) return
    const now = Date.now()
    for (const pos of db.openTrades().filter((t) => t.mode === mode)) {
      const endMs = windowEndMsFromKey(pos.windowKey)
      if (endMs == null || now <= endMs + 2_000) continue
      const outcome = polyOutcomeCache.get(pos.windowKey) ?? db.outcomeFor(pos.windowKey)
      if (!outcome) continue

      const market = openMarketCache.get(pos.windowKey) ?? null
      const tokenId = market ? (pos.side === 'up' ? market.upTokenId : market.downTokenId) : null
      if (!tokenId) continue
      if (polyByToken.has(tokenId)) continue

      const { payout, pnl } = settlementPayout(pos, outcome)
      if (pos.side === outcome) {
        db.closeTrade({
          id: pos.id,
          exitT: now,
          exitPrice: 1,
          exitReason: 'redeem',
          exitFee: 0,
          payout,
          pnl,
        })
      } else {
        db.settleTrade(pos.id, now, payout, pnl)
      }
      stats.settled += 1
      log(
        `${mode.toUpperCase()} RECONCILE ${pos.coin}/${pos.timeframe} ${pos.side} ` +
          `${pos.side === outcome ? 'WIN' : 'loss'} · pnl ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)} (wallet flat)`,
      )
    }
  }

  /** Settlement display for resolved windows — $1/share on win, $0 on loss. */
  function resolvedOpenPnl(
    t: { side: 'up' | 'down'; size: number; cost: number; entryPrice: number },
    outcome: 'up' | 'down',
  ): { phase: 'won' | 'lost'; mark: number; unrealizedPnl: number } {
    const won = t.side === outcome
    const shares = tradeShares(t)
    return won
      ? { phase: 'won', mark: 1, unrealizedPnl: shares - t.cost }
      : { phase: 'lost', mark: 0, unrealizedPnl: -t.cost }
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
    phase: 'live' | 'won' | 'lost' | 'settling'
    redeemable: boolean
    /** Recorded oracle outcome for this window (when known). */
    outcome?: 'up' | 'down'
  }[] {
    const now = Date.now()
    return db.openTrades()
      .filter((t) => t.mode === mode)
      .map((t) => {
        const market = openMarketCache.get(t.windowKey) ?? null
        const endMs = market?.endDate.getTime() ?? windowEndMsFromKey(t.windowKey)
        const msRemaining = endMs != null ? endMs - now : null
        const ended = msRemaining != null && msRemaining <= 0
        const polyOutcome = polyOutcomeCache.get(t.windowKey) ?? null
        const dbOutcome = db.outcomeFor(t.windowKey)
        const settlementOutcome = polyOutcome ?? dbOutcome
        const poly = openPolyCache.get(t.windowKey)

        let phase: 'live' | 'won' | 'lost' | 'settling'
        let mark: number | null
        let unrealizedPnl: number | null
        let redeemable = false

        if (!ended) {
          phase = 'live'
          mark =
            openMarkCache.get(t.windowKey) ?? (market ? bidForSide(deriveBook(market), t.side) : null)
          if (mode === 'live' && poly) {
            mark = poly.curPrice
            unrealizedPnl = poly.cashPnl
          } else {
            unrealizedPnl = mark != null ? mark * t.size - t.cost : null
          }
        } else if (settlementOutcome) {
          const resolved = resolvedOpenPnl(t, settlementOutcome)
          phase = resolved.phase
          mark = resolved.mark
          unrealizedPnl = resolved.unrealizedPnl
          redeemable =
            mode === 'live' && resolved.phase === 'won' && poly?.redeemable === true
        } else if (mode === 'live' && poly) {
          const shares = tradeShares(t)
          if (poly.currentValue > 0.01) {
            phase = 'won'
            mark = 1
            unrealizedPnl = shares - t.cost
            redeemable = poly.redeemable
          } else {
            phase = 'lost'
            mark = 0
            unrealizedPnl = -t.cost
          }
        } else {
          phase = 'settling'
          mark = null
          unrealizedPnl = null
        }

        return {
          coin: t.coin,
          timeframe: t.timeframe,
          side: t.side,
          strategy: t.strategy,
          entryPrice: t.entryPrice,
          size: t.size,
          mark,
          unrealizedPnl,
          msRemaining,
          phase,
          redeemable,
          outcome: settlementOutcome ?? undefined,
        }
      })
  }

  function recordOutcome(
    windowKey: string,
    w: TrackedWindow,
    finalPrice: number,
    now: number,
    source: 'chainlink' | 'api',
    strikeOverride?: number,
  ): void {
    if (source === 'chainlink' && db.hasOutcome(windowKey)) {
      forget(windowKey)
      return
    }
    const strike = strikeOverride ?? w.strike
    const outcome = finalPrice > strike ? 'up' : 'down'
    const row = {
      windowKey,
      coin: w.coin,
      timeframe: w.timeframe,
      strike,
      finalPrice,
      outcome: outcome as 'up' | 'down',
      endMs: w.endMs,
      recordedAt: now,
    }
    if (source === 'api') {
      const existing = db.outcomeFor(windowKey)
      if (existing === outcome) {
        forget(windowKey)
        return
      }
      db.setOutcome(row)
    } else {
      db.upsertOutcome(row)
    }
    stats.outcomes += 1
    forget(windowKey)
    log(
      `OUTCOME ${source} ${w.coin}/${w.timeframe} · ${outcome} @ ${finalPrice.toFixed(2)} ` +
        `(strike ${strike.toFixed(2)})`,
    )
  }

  /** Polymarket crypto-price fallback when the Chainlink stream missed the boundary. */
  function tryCryptoPriceOutcome(windowKey: string, w: TrackedWindow): void {
    if (outcomeResolving.has(windowKey)) return
    const hasOpen = db.openTradesForWindow(windowKey).length > 0
    // Allow API refresh when open positions still need the correct Polymarket outcome.
    if (db.hasOutcome(windowKey) && !hasOpen) return
    outcomeResolving.add(windowKey)
    void fetchWindowOutcome(w.coin as CoinId, w.timeframe, windowKey)
      .then((resolved) => {
        if (!resolved) return
        recordOutcome(windowKey, w, resolved.finalPrice, Date.now(), 'api', resolved.strike)
        settleTrades(Date.now())
      })
      .catch(() => {})
      .finally(() => outcomeResolving.delete(windowKey))
  }

  function refreshMarket(state: ScopeState, now: number): void {
    const ended = state.market ? now >= state.market.endDate.getTime() : true
    if (state.fetching) return
    // Poll faster while this scope holds an open position so exit marks stay fresh.
    const hasOpen =
      state.market != null &&
      db.openTradesForWindow(marketWindowKey(state.market)).length > 0 &&
      (config.strategy === 'swing' || config.strategy === 'value' || config.strategy === 'certainty')
    const endMs = state.market?.endDate.getTime()
    const inCertaintyBand =
      config.strategy === 'certainty' &&
      endMs != null &&
      inCertaintyEntryBand(endMs - now, config)
    const pollMs = hasOpen
      ? config.strategy === 'swing'
        ? config.swingOpenPollMs
        : config.strategy === 'certainty'
          ? config.certaintyOpenPollMs
          : config.valueOpenPollMs
      : inCertaintyBand
        ? config.certaintyOpenPollMs
        : config.marketPollMs
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

  function sampleScope(state: ScopeState, now: number): void | Promise<void> {
    const market = state.market
    if (!market || now >= market.endDate.getTime()) return

    const windowStart = market.startDate?.getTime()
    const chainlinkOpen =
      windowStart != null ? stream.firstPriceAtOrAfter(state.pair, windowStart, 90_000) : null
    const strike =
      config.strategy === 'certainty'
        ? (certaintyStrike(market, chainlinkOpen) ?? market.priceToBeat)
        : (chainlinkOpen ?? market.priceToBeat)
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
    // predictions above but never enter. Open-position exits run regardless.
    if (mode !== 'record') {
      const canEnter = tradeTf.has(state.timeframe)
      if (config.strategy === 'swing') {
        recordMid(pred, now)
        void manageSwing(pred, market, now, canEnter)
      } else if (config.strategy === 'maker') {
        manageMaker(pred, market, now, canEnter)
      } else if (config.strategy === 'value') {
        void manageValue(pred, market, now, canEnter)
      } else if (config.strategy === 'certainty') {
        return manageCertainty(pred, market, spot, strike, now, canEnter)
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
      // Polymarket crypto-price API is the settlement source of truth — always try first.
      tryCryptoPriceOutcome(windowKey, w)
      if (db.hasOutcome(windowKey)) {
        forget(windowKey)
        continue
      }
      // Chainlink fallback only after the API has had time to mark completed (~90s).
      if (now <= w.endMs + 90_000) {
        const hasOpen = db.openTradesForWindow(windowKey).length > 0
        if (!hasOpen && now > w.endMs + OUTCOME_GIVEUP_MS) forget(windowKey)
        continue
      }
      const finalPrice =
        stream.firstPriceAtOrAfter(w.pair, w.endMs, OUTCOME_SLOP_MS) ??
        db.tickAtOrAfter(w.pair, w.endMs, OUTCOME_SLOP_MS)
      if (finalPrice != null) {
        recordOutcome(windowKey, w, finalPrice, now, 'chainlink')
        continue
      }
      const hasOpen = db.openTradesForWindow(windowKey).length > 0
      if (!hasOpen && now > w.endMs + OUTCOME_GIVEUP_MS) forget(windowKey)
    }
  }

  /** Fix oracle rows for open windows using Polymarket's completed crypto-price API. */
  async function repairOpenOutcomesFromPoly(): Promise<void> {
    const seen = new Set<string>()
    for (const t of db.openTrades()) {
      if (seen.has(t.windowKey)) continue
      seen.add(t.windowKey)
      const endMs = windowEndMsFromKey(t.windowKey)
      if (endMs == null || Date.now() <= endMs + 2_000) continue
      const pair = chainlinkPair(t.coin as CoinId)
      if (!pair) continue
      const w: TrackedWindow = tracked.get(t.windowKey) ?? {
        pair,
        coin: t.coin,
        timeframe: t.timeframe,
        strike: db.windowStrike(t.windowKey) ?? 0,
        endMs,
      }
      try {
        const resolved = await fetchWindowOutcome(t.coin as CoinId, t.timeframe, t.windowKey)
        if (!resolved) continue
        const prev = db.outcomeFor(t.windowKey)
        const next = resolved.finalPrice > resolved.strike ? 'up' : 'down'
        polyOutcomeCache.set(t.windowKey, next)
        recordOutcome(t.windowKey, w, resolved.finalPrice, Date.now(), 'api', resolved.strike)
        if (prev !== next) {
          log(`OUTCOME repair ${t.coin}/${t.timeframe} · ${prev ?? '—'} → ${next} (poly API)`)
        }
      } catch {
        /* retry next refresh */
      }
    }
    settleTrades(Date.now())
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
              dailyTrades: db.countTradesSince(Date.now() - 86_400_000, mode),
              maxDailyTrades: effectiveDailyCap(),
              // Traded subset + the full recorded universe it can be toggled across.
              tradeTimeframes: config.timeframes.filter((tf) => tradeTf.has(tf)),
              availableTimeframes: config.timeframes.filter((tf) => recordedTf.has(tf)),
              // Positions still being force-closed at market (strategy switch retries).
              pendingCloses: pendingClose.size,
              swingExits: config.strategy === 'swing' ? db.swingExits() : [],
              valueExits: config.strategy === 'value' ? db.valueExits() : [],
              swingTrigger: config.swingTrigger,
              swingSource: config.signalSource,
              certainty:
                config.strategy === 'certainty'
                  ? {
                      entryWithinSec: config.certaintyEntryWithinSec,
                      minWinProb: config.certaintyMinWinProb,
                      minEdge: config.certaintyMinEdge,
                      maxAsk: config.certaintyMaxAsk,
                      minZ: config.certaintyMinZ,
                      minCoins: config.certaintyMinCoins,
                      maxCoins: config.certaintyMaxCoins,
                      signalSource: config.signalSource,
                    }
                  : undefined,
              openPositions: openPositions(),
              recentClosed: db.recentClosed(8, mode),
              recentTrades: db.recentTrades(8, mode),
              recentActivity: db.recentActivity(8, mode),
              maker: config.strategy === 'maker' ? makerStatus() : undefined,
            }),
            setMode,
            setHalted,
            setStakeUsd,
            setMaxDailyTrades,
            setStrategy,
            setTradeTimeframes,
            setMaker,
            setCertainty,
            getHistory: (query) => db.queryTrades(query),
          },
          Number(process.env.BOT_CONTROL_PORT ?? 8790),
          process.env.BOT_CONTROL_TOKEN?.trim() || undefined,
          log,
        )

  seedTrackedFromOpen()
  await repairOpenOutcomesFromPoly()
  sweepOutcomes(Date.now())
  settleTrades(Date.now())

  let lastStatus = 0
  let lastBalanceRefresh = 0
  let tickRunning = false
  const BALANCE_REFRESH_MS = 60_000
  const timer = setInterval(() => {
    void (async () => {
      if (tickRunning) return
      tickRunning = true
      try {
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
        certaintyCandidates = []
        const certaintyWork: Promise<void>[] = []
        for (const state of scopes) {
          refreshMarket(state, now)
          const work = sampleScope(state, now)
          if (work) certaintyWork.push(work)
        }
        if (mode !== 'record' && config.strategy === 'certainty') {
          await Promise.all(certaintyWork)
          if (certaintyCandidates.length > 0) {
            await pickAndTradeCertainty(certaintyCandidates, now)
          }
        }
        seedTrackedFromOpen()
        sweepOutcomes(now)
        // Finalize maker windows regardless of the current strategy so a switch-away
        // still settles inventory once the boundary outcome lands.
        if (mode !== 'record') finalizeMakerWindows(now)
        if (mode !== 'record') settleTrades(now)
        if (mode !== 'record') await refreshOpenMarkets()
        if (mode !== 'record' && now - lastCertaintyCashSweep >= CERTAINTY_CASH_SWEEP_MS) {
          lastCertaintyCashSweep = now
          void sweepCertaintyCash(now)
        }
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
          const dailyTrades = db.countTradesSince(now - 86_400_000, mode)
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
      } finally {
        tickRunning = false
      }
    })()
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
