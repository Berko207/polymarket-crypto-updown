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

export interface TradeInsert {
  windowKey: string
  coin: string
  timeframe: string
  mode: string
  strategy: string
  side: 'up' | 'down'
  entryT: number
  entryPrice: number
  size: number
  /** Entry notional including the modeled entry fee. */
  cost: number
  /** Modeled taker fee paid on entry (0 when the fee model is off). */
  entryFee: number
  signalEdge: number
  regimeEntry: string | null
  status: string
  orderId: string | null
}

export interface OpenTrade {
  id: number
  side: 'up' | 'down'
  size: number
  cost: number
  entryPrice: number
  strategy: string
}

/** An open position, for the dashboard monitor (live unrealized P&L needs the mark). */
export interface OpenTradeRow {
  id: number
  windowKey: string
  coin: string
  timeframe: string
  side: 'up' | 'down'
  size: number
  cost: number
  entryPrice: number
  strategy: string
  entryT: number
}

/** A finished trade for the monitor's activity feed. */
export interface ClosedTradeRow {
  coin: string
  timeframe: string
  side: 'up' | 'down'
  strategy: string
  entryPrice: number
  exitPrice: number | null
  exitReason: string | null
  pnl: number
  settleT: number
  status: string
}

/** A mid-window close (swing auto-sell), as opposed to a hold-to-settle payout. */
export interface TradeClose {
  id: number
  exitT: number
  exitPrice: number
  exitReason: string
  exitFee: number
  /** Sale proceeds net of the modeled exit fee. */
  payout: number
  pnl: number
}

/** Filters for the dashboard trade-history grid; every field is optional (omit = any). */
export interface TradeQuery {
  mode?: string
  strategy?: string
  coin?: string
  timeframe?: string
  status?: string
  reason?: string
  /** 'win' | 'loss' — among realized (settled/closed) trades only. */
  outcome?: 'win' | 'loss'
  /** entry_t epoch-ms bounds (inclusive). */
  from?: number
  to?: number
  limit?: number
  offset?: number
}

/** A full trade row for the history grid — every persisted column. */
export interface TradeHistoryRow {
  id: number
  windowKey: string
  coin: string
  timeframe: string
  mode: string
  strategy: string
  side: 'up' | 'down'
  entryT: number
  entryPrice: number
  size: number
  cost: number
  entryFee: number
  signalEdge: number
  regimeEntry: string | null
  status: string
  settleT: number | null
  exitPrice: number | null
  exitReason: string | null
  exitFee: number | null
  payout: number | null
  pnl: number | null
  orderId: string | null
}

/** One page of filtered history plus totals for the whole (unpaged) filtered set. */
export interface TradeHistoryPage {
  rows: TradeHistoryRow[]
  total: number
  summary: { realized: number; wins: number; pnl: number; staked: number }
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
  insertTrade(row: TradeInsert): void
  tradeExists(windowKey: string): boolean
  openTradesForWindow(windowKey: string): OpenTrade[]
  settleTrade(id: number, settleT: number, payout: number, pnl: number): void
  /** Close an open position mid-window at a sold price (swing auto-sell). */
  closeTrade(row: TradeClose): void
  countOpenTrades(): number
  countTradesSince(sinceMs: number): number
  /** Open trades whose window already has a recorded outcome — ready to settle. */
  pendingSettlements(): { id: number; side: 'up' | 'down'; size: number; cost: number; outcome: 'up' | 'down' }[]
  /** Aggregate paper/live trade P&L for the status endpoint. */
  tradeSummary(): { entered: number; settled: number; open: number; wins: number; staked: number; pnl: number }
  /** Closed swing trades grouped by exit reason — the scalp's health readout. */
  swingExits(): { reason: string; n: number; wins: number; pnl: number }[]
  /** All currently-open positions (for the dashboard monitor). */
  openTrades(): OpenTradeRow[]
  /** Most-recent finished trades, newest first (activity feed). */
  recentClosed(limit: number): ClosedTradeRow[]
  /** Filtered, paged trade history for the dashboard grid (newest first). */
  queryTrades(query: TradeQuery): TradeHistoryPage
  /** Last recorded strike for a window (from predictions), for outcome sweeps after restart. */
  windowStrike(windowKey: string): number | null
  /** First persisted tick at/after a boundary, within slop (survives bot restarts). */
  tickAtOrAfter(symbol: string, boundaryMs: number, maxSlopMs: number): number | null
  close(): void
}

export function openDb(path: string, readonly = false): BotDb {
  if (!readonly) mkdirSync(dirname(path), { recursive: true })
  const raw = new Database(path, { readonly, fileMustExist: readonly })
  if (!readonly) {
    raw.pragma('journal_mode = WAL')
    raw.pragma('synchronous = NORMAL')
    raw.exec(SCHEMA)
    // Additive migration for DBs created before the swing scalp (M2 recorded
    // value trades only). ALTER ADD COLUMN is a no-op once present.
    const cols = (raw.prepare('PRAGMA table_info(trades)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    const addColumn = (name: string, decl: string): void => {
      if (!cols.includes(name)) raw.exec(`ALTER TABLE trades ADD COLUMN ${name} ${decl}`)
    }
    addColumn('strategy', "TEXT NOT NULL DEFAULT 'value'")
    addColumn('entry_fee', 'REAL NOT NULL DEFAULT 0')
    addColumn('exit_price', 'REAL')
    addColumn('exit_reason', 'TEXT')
    addColumn('exit_fee', 'REAL')
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

  const insTrade = raw.prepare(`
    INSERT INTO trades
      (window_key, coin, timeframe, mode, strategy, side, entry_t, entry_price, size, cost,
       entry_fee, signal_edge, regime_entry, status, order_id)
    VALUES
      (@windowKey, @coin, @timeframe, @mode, @strategy, @side, @entryT, @entryPrice, @size, @cost,
       @entryFee, @signalEdge, @regimeEntry, @status, @orderId)
  `)
  const tradeExistsStmt = raw.prepare('SELECT 1 FROM trades WHERE window_key = ? LIMIT 1')
  const openForWindow = raw.prepare(
    "SELECT id, side, size, cost, entry_price AS entryPrice, strategy FROM trades WHERE window_key = ? AND status = 'open'",
  )
  const settleStmt = raw.prepare(
    "UPDATE trades SET status='settled', settle_t=@settleT, payout=@payout, pnl=@pnl WHERE id=@id",
  )
  const closeStmt = raw.prepare(`
    UPDATE trades SET status='closed', settle_t=@exitT, exit_price=@exitPrice,
      exit_reason=@exitReason, exit_fee=@exitFee, payout=@payout, pnl=@pnl
    WHERE id=@id
  `)
  const openCountStmt = raw.prepare("SELECT COUNT(*) AS n FROM trades WHERE status='open'")
  const sinceCountStmt = raw.prepare('SELECT COUNT(*) AS n FROM trades WHERE entry_t >= ?')
  const pendingStmt = raw.prepare(`
    SELECT t.id AS id, t.side AS side, t.size AS size, t.cost AS cost, o.outcome AS outcome
    FROM trades t JOIN outcomes o ON o.window_key = t.window_key
    WHERE t.status = 'open'
  `)
  // 'settled' (held to $0/$1) and 'closed' (swing auto-sell) are both realized.
  const summaryStmt = raw.prepare(`
    SELECT
      COUNT(*) AS entered,
      COALESCE(SUM(CASE WHEN status IN ('settled','closed') THEN 1 ELSE 0 END), 0) AS settled,
      COALESCE(SUM(CASE WHEN status='open' THEN 1 ELSE 0 END), 0) AS open,
      COALESCE(SUM(CASE WHEN status IN ('settled','closed') AND pnl>0 THEN 1 ELSE 0 END), 0) AS wins,
      COALESCE(SUM(CASE WHEN status IN ('settled','closed') THEN cost ELSE 0 END), 0) AS staked,
      COALESCE(SUM(CASE WHEN status IN ('settled','closed') THEN pnl ELSE 0 END), 0) AS pnl
    FROM trades
  `)
  const swingExitsStmt = raw.prepare(`
    SELECT
      COALESCE(exit_reason, '—') AS reason,
      COUNT(*) AS n,
      COALESCE(SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END), 0) AS wins,
      COALESCE(SUM(pnl), 0) AS pnl
    FROM trades
    WHERE status='closed' AND strategy='swing'
    GROUP BY exit_reason
    ORDER BY n DESC
  `)
  const openTradesStmt = raw.prepare(`
    SELECT id, window_key AS windowKey, coin, timeframe, side, size, cost,
           entry_price AS entryPrice, strategy, entry_t AS entryT
    FROM trades WHERE status='open' ORDER BY entry_t DESC
  `)
  const recentClosedStmt = raw.prepare(`
    SELECT coin, timeframe, side, strategy, entry_price AS entryPrice,
           exit_price AS exitPrice, exit_reason AS exitReason, pnl,
           settle_t AS settleT, status
    FROM trades WHERE status IN ('settled','closed')
    ORDER BY settle_t DESC LIMIT ?
  `)
  const windowStrikeStmt = raw.prepare(
    'SELECT strike FROM predictions WHERE window_key = ? ORDER BY t DESC LIMIT 1',
  )
  const tickAtOrAfterStmt = raw.prepare(
    'SELECT value FROM ticks WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1',
  )

  return {
    raw,
    insertTick: (row) => void insTick.run(row),
    insertPrediction: (row) => void insPred.run(row),
    upsertOutcome: (row) => void upsOutcome.run(row),
    hasOutcome: (windowKey) => outCount.get(windowKey) != null,
    insertTrade: (row) => void insTrade.run(row),
    tradeExists: (windowKey) => tradeExistsStmt.get(windowKey) != null,
    openTradesForWindow: (windowKey) => openForWindow.all(windowKey) as OpenTrade[],
    settleTrade: (id, settleT, payout, pnl) => void settleStmt.run({ id, settleT, payout, pnl }),
    closeTrade: (row) => void closeStmt.run(row),
    countOpenTrades: () => (openCountStmt.get() as { n: number }).n,
    countTradesSince: (sinceMs) => (sinceCountStmt.get(sinceMs) as { n: number }).n,
    pendingSettlements: () =>
      pendingStmt.all() as { id: number; side: 'up' | 'down'; size: number; cost: number; outcome: 'up' | 'down' }[],
    tradeSummary: () =>
      summaryStmt.get() as {
        entered: number
        settled: number
        open: number
        wins: number
        staked: number
        pnl: number
      },
    swingExits: () =>
      swingExitsStmt.all() as { reason: string; n: number; wins: number; pnl: number }[],
    openTrades: () => openTradesStmt.all() as OpenTradeRow[],
    recentClosed: (limit) => recentClosedStmt.all(limit) as ClosedTradeRow[],
    queryTrades: (q) => {
      // Build the WHERE dynamically; every value is a bound param (never interpolated).
      const where: string[] = []
      const params: Record<string, unknown> = {}
      const eq = (col: string, key: keyof TradeQuery): void => {
        const v = q[key]
        if (v != null && v !== '') {
          where.push(`${col} = @${key}`)
          params[key] = v
        }
      }
      eq('mode', 'mode')
      eq('strategy', 'strategy')
      eq('coin', 'coin')
      eq('timeframe', 'timeframe')
      eq('status', 'status')
      eq('exit_reason', 'reason')
      if (q.from != null) {
        where.push('entry_t >= @from')
        params.from = q.from
      }
      if (q.to != null) {
        where.push('entry_t <= @to')
        params.to = q.to
      }
      if (q.outcome === 'win') where.push("status IN ('settled','closed') AND pnl > 0")
      if (q.outcome === 'loss') where.push("status IN ('settled','closed') AND pnl <= 0")
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const limit = Math.min(Math.max(Math.trunc(q.limit ?? 200), 1), 2000)
      const offset = Math.max(Math.trunc(q.offset ?? 0), 0)

      const rows = raw
        .prepare(
          `SELECT id, window_key AS windowKey, coin, timeframe, mode, strategy, side,
                  entry_t AS entryT, entry_price AS entryPrice, size, cost, entry_fee AS entryFee,
                  signal_edge AS signalEdge, regime_entry AS regimeEntry, status,
                  settle_t AS settleT, exit_price AS exitPrice, exit_reason AS exitReason,
                  exit_fee AS exitFee, payout, pnl, order_id AS orderId
           FROM trades ${clause}
           ORDER BY entry_t DESC
           LIMIT @__limit OFFSET @__offset`,
        )
        .all({ ...params, __limit: limit, __offset: offset }) as TradeHistoryRow[]

      const agg = raw
        .prepare(
          `SELECT
             COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN status IN ('settled','closed') THEN 1 ELSE 0 END), 0) AS realized,
             COALESCE(SUM(CASE WHEN status IN ('settled','closed') AND pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
             COALESCE(SUM(CASE WHEN status IN ('settled','closed') THEN pnl ELSE 0 END), 0) AS pnl,
             COALESCE(SUM(CASE WHEN status IN ('settled','closed') THEN cost ELSE 0 END), 0) AS staked
           FROM trades ${clause}`,
        )
        .get(params) as { total: number; realized: number; wins: number; pnl: number; staked: number }

      return {
        rows,
        total: agg.total,
        summary: { realized: agg.realized, wins: agg.wins, pnl: agg.pnl, staked: agg.staked },
      }
    },
    windowStrike: (windowKey) =>
      (windowStrikeStmt.get(windowKey) as { strike: number } | undefined)?.strike ?? null,
    tickAtOrAfter: (symbol, boundaryMs, maxSlopMs) =>
      (tickAtOrAfterStmt.get(symbol, boundaryMs, boundaryMs + maxSlopMs) as { value: number } | undefined)
        ?.value ?? null,
    close: () => raw.close(),
  }
}
