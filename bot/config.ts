/**
 * Bot configuration from BOT_* env, with defaults. M1 uses the recorder-relevant
 * fields; the strategy fields are locked now (entry fires late, ~T-10s per the
 * operator's steer) so M2 inherits them without a re-decision.
 */
import { COINS, getSeriesSlug } from '../src/lib/config'
import { chainlinkPair } from '../src/lib/cryptoPrice'
import type { CoinId, TimeframeId } from '../src/lib/types'

export interface BotConfig {
  coins: CoinId[]
  timeframes: TimeframeId[]
  dbPath: string
  /** Main loop cadence — must be ≤ a few s so M2 can fire at T-10s. */
  tickMs: number
  /** Min gap between persisted prediction samples per window. */
  sampleMs: number
  /** How often to re-poll gamma for a scope's current market/odds. */
  marketPollMs: number
  /**
   * Entry/exit family:
   *  'value' = late ~T-10s edge bet, held to settlement ($0/$1) — the original.
   *  'swing' = fade a fresh odds overshoot, auto take-profit/stop mid-window.
   */
  strategy: 'value' | 'swing'
  // --- value strategy (fires late, ~T-10s) ---
  /** Fire the entry when this many seconds remain (late, near settle). */
  entryAtSec: number
  /** Tolerance around entryAtSec — the loop only sees discrete ticks. */
  entryToleranceSec: number
  edgeThreshold: number
  stakeUsd: number
  maxDailyTrades: number
  maxConcurrent: number
  // --- swing scalp (strategy='swing') ---
  /** Min market-mid move over swingWindowSec to count as a swing. */
  swingMovePts: number
  /** Lookback for measuring the swing. */
  swingWindowSec: number
  /** Model edge (for the faded side) required to confirm the overshoot. */
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
  // --- fee model (paper realism; see engine/fees.ts) ---
  /** Taker feeRate for the parabolic fee (crypto ≈ 0.07; 0 disables). */
  feeRate: number
  /** Also charge the fee on the exit (sell) leg — off matches Polymarket today. */
  feeSell: boolean
}

const ALL_COINS = COINS.map((c) => c.id)
/** Default bot universe — the coins the edge model was calibrated/forward-tested on.
 * doge/bnb DO stream on RTDS now, but stay opt-in (BOT_COINS=...,doge,bnb) so adding
 * a Chainlink pair for the dashboard can never silently widen live trading scope. */
const DEFAULT_COINS: CoinId[] = ['btc', 'eth', 'sol', 'xrp']
const KNOWN_TF: TimeframeId[] = ['5m', '15m', '1h', '4h', 'daily']

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
  const timeframes = parseList<TimeframeId>(env.BOT_TIMEFRAMES, KNOWN_TF, ['5m', '15m'])
  const strategy: 'value' | 'swing' =
    env.BOT_STRATEGY?.trim().toLowerCase() === 'swing' ? 'swing' : 'value'

  return {
    coins,
    timeframes,
    dbPath: env.BOT_DB_PATH?.trim() || 'bot/data.db',
    tickMs: num(env.BOT_TICK_MS, 1_000),
    sampleMs: num(env.BOT_SAMPLE_MS, 10_000),
    marketPollMs: num(env.BOT_MARKET_POLL_MS, 5_000),
    strategy,
    entryAtSec: num(env.BOT_ENTRY_AT_SEC, 10),
    entryToleranceSec: num(env.BOT_ENTRY_TOLERANCE_SEC, 4),
    edgeThreshold: num(env.BOT_EDGE_THRESHOLD, 0.05),
    stakeUsd: num(env.BOT_STAKE_USD, 1),
    maxDailyTrades: num(env.BOT_MAX_DAILY_TRADES, 50),
    maxConcurrent: num(env.BOT_MAX_CONCURRENT, 5),
    swingMovePts: num(env.BOT_SWING_MOVE_PTS, 0.04),
    swingWindowSec: num(env.BOT_SWING_WINDOW_SEC, 20),
    swingEdgeMin: num(env.BOT_SWING_EDGE_MIN, 0.03),
    swingTakeProfitPts: num(env.BOT_SWING_TAKE_PROFIT_PTS, 0.03),
    swingStopLossPts: num(env.BOT_SWING_STOP_LOSS_PTS, 0.04),
    swingExitEdge: numNonNeg(env.BOT_SWING_EXIT_EDGE, 0.01),
    swingTimeStopSec: num(env.BOT_SWING_TIME_STOP_SEC, 20),
    swingCooldownSec: num(env.BOT_SWING_COOLDOWN_SEC, 30),
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
