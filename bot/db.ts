/**
 * SQLite persistence (better-sqlite3). Mirrors the browser IndexedDB schema
 * (predictions/outcomes) plus raw ticks (for offline replay) and a trades table
 * (unused in M1, created now so M2 needs no migration).
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface TickRow {
  symbol: string
  ts: number
  value: number
  carried: number
}

export interface PredictionRow {
  windowKey: string
  coin: string
  timeframe: string
  t: number
  msRemaining: number
  spot: number
  strike: number
  modelP: number
  regimeP: number | null
  regime: string | null
  regimeRatio: number | null
  marketP: number
  upBid: number | null
  upAsk: number | null
  sigmaWindow: number
  confidence: string
}

export interface OutcomeRow {
  windowKey: string
  coin: string
  timeframe: string
  strike: number
  finalPrice: number
  outcome: 'up' | 'down'
  endMs: number
  recordedAt: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ticks (
  symbol TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL,
  carried INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, ts)
);
CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  window_key TEXT NOT NULL, coin TEXT NOT NULL, timeframe TEXT NOT NULL,
  t INTEGER NOT NULL, ms_remaining INTEGER NOT NULL,
  spot REAL NOT NULL, strike REAL NOT NULL,
  model_p REAL NOT NULL, regime_p REAL, regime TEXT, regime_ratio REAL,
  market_p REAL NOT NULL, up_bid REAL, up_ask REAL,
  sigma_window REAL NOT NULL, confidence TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pred_window ON predictions(window_key);
CREATE INDEX IF NOT EXISTS idx_pred_t ON predictions(t);
CREATE TABLE IF NOT EXISTS outcomes (
  window_key TEXT PRIMARY KEY, coin TEXT NOT NULL, timeframe TEXT NOT NULL,
  strike REAL NOT NULL, final_price REAL NOT NULL, outcome TEXT NOT NULL,
  end_ms INTEGER NOT NULL, recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_out_end ON outcomes(end_ms);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  window_key TEXT NOT NULL, coin TEXT NOT NULL, timeframe TEXT NOT NULL,
  mode TEXT NOT NULL, side TEXT NOT NULL,
  entry_t INTEGER NOT NULL, entry_price REAL NOT NULL, size REAL NOT NULL,
  cost REAL NOT NULL, signal_edge REAL NOT NULL, regime_entry TEXT,
  status TEXT NOT NULL, settle_t INTEGER, payout REAL, pnl REAL,
  order_id TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_window ON trades(window_key);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
`

export interface BotDb {
  raw: Database.Database
  insertTick(row: TickRow): void
  insertPrediction(row: PredictionRow): void
  upsertOutcome(row: OutcomeRow): void
  hasOutcome(windowKey: string): boolean
  close(): void
}

export function openDb(path: string, readonly = false): BotDb {
  if (!readonly) mkdirSync(dirname(path), { recursive: true })
  const raw = new Database(path, { readonly, fileMustExist: readonly })
  if (!readonly) {
    raw.pragma('journal_mode = WAL')
    raw.pragma('synchronous = NORMAL')
    raw.exec(SCHEMA)
  }

  const insTick = raw.prepare(
    'INSERT OR IGNORE INTO ticks (symbol, ts, value, carried) VALUES (@symbol, @ts, @value, @carried)',
  )
  const insPred = raw.prepare(`
    INSERT INTO predictions
      (window_key, coin, timeframe, t, ms_remaining, spot, strike, model_p, regime_p,
       regime, regime_ratio, market_p, up_bid, up_ask, sigma_window, confidence)
    VALUES
      (@windowKey, @coin, @timeframe, @t, @msRemaining, @spot, @strike, @modelP, @regimeP,
       @regime, @regimeRatio, @marketP, @upBid, @upAsk, @sigmaWindow, @confidence)
  `)
  const upsOutcome = raw.prepare(`
    INSERT INTO outcomes
      (window_key, coin, timeframe, strike, final_price, outcome, end_ms, recorded_at)
    VALUES (@windowKey, @coin, @timeframe, @strike, @finalPrice, @outcome, @endMs, @recordedAt)
    ON CONFLICT(window_key) DO NOTHING
  `)
  const outCount = raw.prepare('SELECT 1 FROM outcomes WHERE window_key = ? LIMIT 1')

  return {
    raw,
    insertTick: (row) => void insTick.run(row),
    insertPrediction: (row) => void insPred.run(row),
    upsertOutcome: (row) => void upsOutcome.run(row),
    hasOutcome: (windowKey) => outCount.get(windowKey) != null,
    close: () => raw.close(),
  }
}
