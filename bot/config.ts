/**
 * Bot configuration from BOT_* env, with defaults. M1 uses the recorder-relevant
 * fields; strategy fields are shared by M2 (value = cheap-side edge to settlement).
 */
import { COINS, getSeriesSlug } from '../src/lib/config'
import { chainlinkPair } from '../src/lib/cryptoPrice'
import type { CoinId, TimeframeId } from '../src/lib/types'

/**
 * Swing entry trigger:
 *  'edge' = trust the model — enter as soon as |model − market| ≥ swingEdgeMin,
 *           whichever side the model underprices (catches model-driven edges AND
 *           market overshoots; does not wait for a spike).
 *  'move' = only enter when a market spike ≥ swingMovePts confirms the edge (the
 *           stricter fade — fewer, spike-confirmed entries).
 */
export type SwingTrigger = 'edge' | 'move'

/**
 * Which fair-value probability drives the edge:
 *  'flat'   = the plain realized-vol model (modelP).
 *  'regime' = the regime-conditional model (regimeP).
 *  'blend'  = regimeP while vol is elevated/panic, else flat (lean on the regime
 *             model only where it's most likely to be the more accurate one).
 */
export type SignalSource = 'flat' | 'regime' | 'blend'

export interface BotConfig {
  coins: CoinId[]
  /** Recorded universe — every coin×timeframe here is polled/logged. */
  timeframes: TimeframeId[]
  /**
   * Subset of `timeframes` that entries actually fire on (recording still covers
   * all of `timeframes`). Lets 5m stay a recorded dataset while not being traded —
   * it bled net-negative even before fees, whereas 15m/1h/4h held up. Runtime-
   * adjustable from the dashboard. Always intersected with `timeframes`.
   */
  tradeTimeframes: TimeframeId[]
  dbPath: string
  /** Main loop cadence — must be ≤ a few s so entries can fire mid-window. */
  tickMs: number
  /** Min gap between persisted prediction samples per window. */
  sampleMs: number
  /** How often to re-poll gamma for a scope's current market/odds. */
  marketPollMs: number
  /**
   * Entry/exit family:
   *  'value' = model edge on the cheap side, held to settlement ($0/$1).
   *  'swing' = fade a fresh odds overshoot, auto take-profit/stop mid-window.
   *  'maker' = post two-sided passive limit quotes; capture spread + rebate (paper).
   */
  strategy: 'value' | 'swing' | 'maker'
  // --- value strategy (edge + cheap ask, any time in window) ---
  edgeThreshold: number
  /** Skip value entries when the buy ask is above this (avoids 90¢ favorites). */
  valueMaxEntryPrice: number
  stakeUsd: number
  /** Max entries in a rolling 24h window; 0 = unlimited (paper default). Live falls back to 50. */
  maxDailyTrades: number
  maxConcurrent: number
  // --- swing scalp (strategy='swing') ---
  /** How entries fire: trust the model ('edge') or require a spike ('move'). */
  swingTrigger: SwingTrigger
  /** Which fair-value probability drives the edge (flat / regime / blend). */
  signalSource: SignalSource
  /** Min market-mid move over swingWindowSec to count as a swing (trigger='move'). */
  swingMovePts: number
  /** Lookback for measuring the swing. */
  swingWindowSec: number
  /** Min |model − market| edge to enter (and its side is the model's cheap side). */
  swingEdgeMin: number
  /** Exit when the mark rises this far above entry (bank the scalp). */
  swingTakeProfitPts: number
  /** Exit when the mark falls this far below entry (cut the loss). */
  swingStopLossPts: number
  /** Exit when the faded side's edge decays to/below this (mispricing gone). */
  swingExitEdge: number
  /** Force-close this many seconds before settlement (avoid binary variance). */
  swingTimeStopSec: number
  /** Min gap after a close before re-entering the same window. */
  swingCooldownSec: number
  // --- guardrails: keep it a mid-market scalp, not a favorite-chase ---
  /** Skip entries when market P(Up) is below this (buying a longshot). */
  swingMinPrice: number
  /** Skip entries when market P(Up) is above this (buying a favorite). */
  swingMaxPrice: number
  /** Skip the calm regime, where the market out-predicts the model (Brier). */
  swingSkipCalm: boolean
  /** Poll cadence for a scope that holds an open position (tightens the stop). */
  swingOpenPollMs: number
  // --- maker strategy (strategy='maker'; see engine/maker.ts + docs/maker-paper-strategy.md) ---
  /** Fill-sim fidelity: 'L1' trade-through, 'L2' also models queue-ahead. */
  makerFillModel: 'L1' | 'L2'
  /** Half-spread floor (pts) each quote sits off the reservation price. */
  makerBaseSpread: number
  /** Widen the half-spread per unit of sigmaWindow. */
  makerVolCoef: number
  /** Widen the half-spread per unit of toxicity (adverse flow; Phase 2). */
  makerToxCoef: number
  /** Reservation-price skew at full inventory (shifts quotes to shed inventory). */
  makerInvSkew: number
  /** Notional ($) per quote; shares = clip / price, scaled by inventory room. */
  makerClipUsd: number
  /** Net-share inventory cap per window (also the kill trigger). */
  makerMaxInventory: number
  /** Weight on the book microprice when blending fair value (0 = pure model). */
  makerMicropriceWeight: number
  /** Rebate per filled share — 0 by default (see makerFees.ts / spec open Q1). */
  makerRebateRate: number
  /** FV move that forces a cancel-replace of a resting quote. */
  makerRequoteEdge: number
  /** Min gap between requotes on a side (ms). */
  makerMinRequoteMs: number
  /** Start widening quotes once the window is within this many seconds of close. */
  makerWidenSec: number
  /** Pull all quotes once within this many seconds of close. */
  makerPullSec: number
  /** Flatten residual inventory at market this many seconds before close. */
  makerFlattenSec: number
  /** Hold residual inventory to $0/$1 settlement instead of flattening (A/B variant). */
  makerLetRide: boolean
  // --- fee model (paper realism; see engine/fees.ts) ---
  /** Taker feeRate for the parabolic fee (crypto ≈ 0.07; 0 disables). */
  feeRate: number
  /** Also charge the fee on the exit (sell) leg — off matches Polymarket today. */
  feeSell: boolean
}

const ALL_COINS = COINS.map((c) => c.id)
/** Default bot universe — all Chainlink-streamed up/down coins. Override with BOT_COINS. */
const DEFAULT_COINS: CoinId[] = ['btc', 'eth', 'sol', 'xrp', 'doge', 'bnb']
const KNOWN_TF: TimeframeId[] = ['5m', '15m', '1h', '4h', 'daily']
/** Recorded by default — 5m kept for its dataset even though it's not traded. */
const DEFAULT_RECORD_TF: TimeframeId[] = ['5m', '15m', '1h', '4h']
/** Traded by default — 5m/15m/1h; 4h excluded (slow, low upside at favorites). */
const DEFAULT_TRADE_TF: TimeframeId[] = ['5m', '15m', '1h']

function parseList<T extends string>(raw: string | undefined, valid: T[], fallback: T[]): T[] {
  if (!raw) return fallback
  const set = new Set(valid)
  const picked = raw
    .split(',')
    .map((s) => s.trim().toLowerCase() as T)
    .filter((s) => set.has(s))
  return picked.length ? picked : fallback
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Like num() but allows 0 — for knobs where zero is meaningful (fee off, edge≤0). */
function numNonNeg(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function loadConfig(): BotConfig {
  const env = process.env
  // Only Chainlink-streamed coins can be modeled; BOT_COINS may opt into any of them.
  const coinsAll = parseList<CoinId>(env.BOT_COINS, ALL_COINS, DEFAULT_COINS)
  const coins = coinsAll.filter((c) => chainlinkPair(c))
  const timeframes = parseList<TimeframeId>(env.BOT_TIMEFRAMES, KNOWN_TF, DEFAULT_RECORD_TF)
  // Trade only a subset of what's recorded. Intersect with `timeframes` so we can
  // never "trade" a timeframe that isn't being fetched; if that leaves nothing
  // (e.g. BOT_TIMEFRAMES excludes every trade default), fall back to trading all
  // recorded timeframes so the bot never silently goes no-op.
  const tradeWanted = parseList<TimeframeId>(env.BOT_TRADE_TIMEFRAMES, KNOWN_TF, DEFAULT_TRADE_TF)
  const tradeIntersect = tradeWanted.filter((tf) => timeframes.includes(tf))
  const tradeTimeframes = tradeIntersect.length ? tradeIntersect : timeframes
  const strategyRaw = env.BOT_STRATEGY?.trim().toLowerCase()
  const strategy: 'value' | 'swing' | 'maker' =
    strategyRaw === 'swing' ? 'swing' : strategyRaw === 'maker' ? 'maker' : 'value'
  const makerFillModel: 'L1' | 'L2' =
    env.BOT_MAKER_FILL_MODEL?.trim().toUpperCase() === 'L2' ? 'L2' : 'L1'
  const swingTrigger: SwingTrigger =
    env.BOT_SWING_TRIGGER?.trim().toLowerCase() === 'move' ? 'move' : 'edge'
  const sourceRaw = env.BOT_SIGNAL_SOURCE?.trim().toLowerCase()
  const signalSource: SignalSource =
    sourceRaw === 'regime' || sourceRaw === 'blend' ? sourceRaw : 'flat'

  return {
    coins,
    timeframes,
    tradeTimeframes,
    dbPath: env.BOT_DB_PATH?.trim() || 'bot/data.db',
    tickMs: num(env.BOT_TICK_MS, 1_000),
    sampleMs: num(env.BOT_SAMPLE_MS, 10_000),
    marketPollMs: num(env.BOT_MARKET_POLL_MS, 5_000),
    strategy,
    swingTrigger,
    signalSource,
    edgeThreshold: num(env.BOT_EDGE_THRESHOLD, 0.05),
    valueMaxEntryPrice: num(env.BOT_VALUE_MAX_ENTRY_PRICE, 0.5),
    stakeUsd: num(env.BOT_STAKE_USD, 1),
    maxDailyTrades: numNonNeg(env.BOT_MAX_DAILY_TRADES, 0),
    maxConcurrent: num(env.BOT_MAX_CONCURRENT, 5),
    swingMovePts: num(env.BOT_SWING_MOVE_PTS, 0.04),
    swingWindowSec: num(env.BOT_SWING_WINDOW_SEC, 20),
    swingEdgeMin: num(env.BOT_SWING_EDGE_MIN, 0.03),
    swingTakeProfitPts: num(env.BOT_SWING_TAKE_PROFIT_PTS, 0.03),
    swingStopLossPts: num(env.BOT_SWING_STOP_LOSS_PTS, 0.04),
    swingExitEdge: numNonNeg(env.BOT_SWING_EXIT_EDGE, 0.01),
    swingTimeStopSec: num(env.BOT_SWING_TIME_STOP_SEC, 20),
    swingCooldownSec: num(env.BOT_SWING_COOLDOWN_SEC, 30),
    swingMinPrice: numNonNeg(env.BOT_SWING_MIN_PRICE, 0.2),
    swingMaxPrice: num(env.BOT_SWING_MAX_PRICE, 0.8),
    swingSkipCalm: env.BOT_SWING_SKIP_CALM !== '0',
    swingOpenPollMs: num(env.BOT_SWING_OPEN_POLL_MS, 2_000),
    makerFillModel,
    makerBaseSpread: num(env.BOT_MAKER_BASE_SPREAD, 0.02),
    makerVolCoef: numNonNeg(env.BOT_MAKER_VOL_COEF, 0.5),
    makerToxCoef: numNonNeg(env.BOT_MAKER_TOX_COEF, 0.3),
    makerInvSkew: numNonNeg(env.BOT_MAKER_INV_SKEW, 0.02),
    makerClipUsd: num(env.BOT_MAKER_CLIP_USD, 1),
    makerMaxInventory: num(env.BOT_MAKER_MAX_INVENTORY, 20),
    makerMicropriceWeight: numNonNeg(env.BOT_MAKER_MICROPRICE_WEIGHT, 0),
    makerRebateRate: numNonNeg(env.BOT_MAKER_REBATE_RATE, 0),
    makerRequoteEdge: num(env.BOT_MAKER_REQUOTE_EDGE, 0.01),
    makerMinRequoteMs: num(env.BOT_MAKER_MIN_REQUOTE_MS, 1_500),
    makerWidenSec: num(env.BOT_MAKER_WIDEN_SEC, 60),
    makerPullSec: num(env.BOT_MAKER_PULL_SEC, 20),
    makerFlattenSec: num(env.BOT_MAKER_FLATTEN_SEC, 15),
    makerLetRide: env.BOT_MAKER_LET_RIDE === '1',
    feeRate: numNonNeg(env.BOT_FEE_RATE, 0.07),
    feeSell: env.BOT_FEE_SELL === '1',
  }
}

/** Scopes to record: coin × timeframe pairs that actually exist as a series. */
export function activeScopes(config: BotConfig): { coin: CoinId; timeframe: TimeframeId }[] {
  const out: { coin: CoinId; timeframe: TimeframeId }[] = []
  for (const coin of config.coins) {
    for (const timeframe of config.timeframes) {
      if (getSeriesSlug(coin, timeframe)) out.push({ coin, timeframe })
    }
  }
  return out
}
