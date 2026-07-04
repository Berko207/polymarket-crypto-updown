# Local trading bot — design plan

Status: **draft for review** · Author: pairing session 2026-07-04 · Target: a
headless bot that runs on the operator's own machine, records 24/7, and
paper-trades first (dry), then live. **Not** deployed on Vercel.

---

## 1. Goal & principles

Run a long-lived Node process on local disk that:

1. **Records** flat + regime predictions and window outcomes for every
   in-scope market, 24/7, independent of any browser tab. (Fixes the current
   "recorder only runs while a tab is open" limitation.)
2. **Dry-trades** the existing edge/regime signal into a local ledger —
   simulated fills, paper P&L, zero real orders.
3. **Live-trades** later, behind explicit flags and the guards that already
   exist server-side.

Principles:

- **Dry by default.** Live requires an explicit mode flag + a promotion gate.
  There is no code path where an unconfigured or default run places a real order.
- **SQLite on disk** (`better-sqlite3`) — the right store for a local long-lived
  process. Queryable, durable, no infra. (A local `.db` file could *not* persist
  on Vercel serverless — irrelevant here, since we're not on Vercel.)
- **Reuse the proven code.** The model and the order path already exist and are
  pure Node; the bot wires them to Node-native data sources and a ledger. No
  re-derivation of pricing or order logic.
- **Same signal as the dashboard.** The bot trades exactly what the browser's
  `FairValue.signal` surfaces, so dry results transfer to what you see live.

## 2. Non-goals (v1)

- No new alpha model — v1 trades the *current* fair-value edge + panic gate.
- No web UI — a CLI `report` command + the existing dashboard (which can read
  the same markets) are enough. (A read-only viewer can come later.)
- No multi-account / multi-wallet. Single operator, single funder.

## 3. Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │              bot process (Node, tsx)         │
                    │                                              │
  RTDS WS  ───────► │  ticks ──►  vol/regime  ┐                    │
 (chainlink)        │                          ├─► signal engine   │
  gamma HTTP ─────► │  odds/tokens ─► markets ─┘        │          │
 (events by slug)   │                                    ▼          │
  CLOB WS/REST ───► │  live book (bid/ask) ────────► executor       │
 (best bid/ask)     │                              (dry │ live)     │
                    │        │                          │           │
                    │        ▼                          ▼           │
                    │   SQLite: ticks, predictions, outcomes, trades │
                    └─────────────────────────────────────────────┘
                                     │
                            pnpm bot:report → P&L / Brier / per-regime
```

**Loop (per ~1s tick or per market poll):**
1. Discover / refresh in-scope markets (slug candidates → gamma) — reuse
   `buildEventSlugCandidates` + `windowEndFromEventSlug`.
2. For each live window: pull latest Chainlink ticks → `realizedVol` +
   `regimeVol`; compute `probabilityUp` (flat σ) and regime-σ P(Up); read
   book mid/ask for `marketP`.
3. **Record** a prediction row (throttled, e.g. every 10s like the browser).
4. On resolution, **record** the outcome row (first tick at/after window end).
5. **Signal → executor**: if entry criteria hold and no open position for this
   window, place a (dry or live) buy; record a trade row. Reconcile P&L at
   settle.

## 4. Reused vs new

| Concern | Source | Reuse? |
|---|---|---|
| Regime model | `src/lib/regime.ts` | as-is (pure) |
| Fair value / Φ(d₂) / vol | `src/lib/fairValue.ts` | as-is (pure) |
| Market discovery / window end | `src/lib/slugs.ts` | as-is (pure) |
| Coin/timeframe/series config | `src/lib/config.ts` | as-is |
| Chainlink pair mapping | `src/lib/cryptoPrice.ts` (`chainlinkPair`) | as-is |
| Order placement | `api/_lib/clob.ts` (`placeMarketOrder`, `fetchUsdcBalance`, `fetchAccountSnapshot`) | as-is (Node; reads `process.env`) |
| RTDS tick stream | `src/lib/chainlinkSocket.ts` | **port** to Node `WebSocket` (logic identical; drop the singleton/DOM assumptions) |
| Gamma odds fetch | browser hits `/api/gamma/...` proxy | **new**: hit `https://gamma-api.polymarket.com/events?slug=…` directly |
| CLOB live book | `src/lib/clobSocket.ts` | **port** (optional — REST book-walk via `calculateMarketPrice` already exists for entry pricing) |
| Prediction schema | `src/lib/predictionLog.ts` (IndexedDB) | **mirror** into SQLite tables |
| Order guards (size/cost/balance) | `api/orders.ts` handler | **extract** into a shared `guardOrder()` the bot and the API both call |

Node 22+ has global `fetch` and `WebSocket`, so the ported pieces need no new
deps beyond the driver. `.env.local` loaded via `dotenv` (or `tsx --env-file`).

## 5. Project layout

```
bot/
  index.ts          # entry: parse mode, start loop
  config.ts         # BOT_* env → typed config
  db.ts             # better-sqlite3 open + migrations + prepared statements
  sources/
    chainlink.ts    # ported RTDS stream (Node WebSocket)
    gamma.ts        # slug → market fetch (direct gamma)
    book.ts         # best bid/ask (CLOB REST/WS) for entry pricing
  engine/
    predict.ts      # ticks+market → {modelP, regimeP, regime, marketP, confidence, signal}
    strategy.ts     # signal → intended order (side, stake, entry gate)
    executor.ts     # interface Executor; dryExecutor | liveExecutor
    reconcile.ts    # settle open trades against outcomes → P&L
  report.ts         # SQLite → P&L / hit-rate / Brier / per-regime summary
  data.db           # gitignored
```

Reuses `src/lib/*` and `api/_lib/*` by direct import (run via `tsx`).

## 6. SQLite schema

```sql
-- Raw oracle ticks (enables offline replay/backtest with different params).
-- Optional/prunable; ~6 coins × ~1 tick/1-3s. Prune > 60d.
CREATE TABLE ticks (
  symbol    TEXT NOT NULL,          -- chainlink pair, e.g. 'btc/usd'
  ts        INTEGER NOT NULL,       -- oracle ms
  value     REAL NOT NULL,
  carried   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, ts)
);
CREATE INDEX idx_ticks_symbol_ts ON ticks(symbol, ts);

-- One row per prediction sample (mirrors PredictionSample + regime fields).
CREATE TABLE predictions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  window_key   TEXT NOT NULL,
  coin         TEXT NOT NULL,
  timeframe    TEXT NOT NULL,
  t            INTEGER NOT NULL,     -- sample wall-clock ms
  ms_remaining INTEGER NOT NULL,
  spot         REAL NOT NULL,
  strike       REAL NOT NULL,
  model_p      REAL NOT NULL,       -- flat σ
  regime_p     REAL,                -- regime σ (nullable)
  regime       TEXT,                -- calm|normal|elevated|panic
  regime_ratio REAL,
  market_p     REAL NOT NULL,
  up_bid REAL, up_ask REAL,
  sigma_window REAL NOT NULL,
  confidence   TEXT NOT NULL
);
CREATE INDEX idx_pred_window ON predictions(window_key);
CREATE INDEX idx_pred_t      ON predictions(t);

-- One row per resolved window.
CREATE TABLE outcomes (
  window_key  TEXT PRIMARY KEY,
  coin TEXT NOT NULL, timeframe TEXT NOT NULL,
  strike REAL NOT NULL, final_price REAL NOT NULL,
  outcome TEXT NOT NULL,            -- 'up' | 'down'
  end_ms INTEGER NOT NULL, recorded_at INTEGER NOT NULL
);
CREATE INDEX idx_out_end ON outcomes(end_ms);

-- Paper + live trades.
CREATE TABLE trades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  window_key    TEXT NOT NULL,
  coin TEXT NOT NULL, timeframe TEXT NOT NULL,
  mode          TEXT NOT NULL,       -- 'dry' | 'live'
  side          TEXT NOT NULL,       -- 'up' | 'down'
  entry_t       INTEGER NOT NULL,
  entry_price   REAL NOT NULL,       -- fill price (sim ask / real avg fill)
  size          REAL NOT NULL,       -- shares
  cost          REAL NOT NULL,       -- USDC in
  signal_edge   REAL NOT NULL,       -- modelP-marketP at entry
  regime_entry  TEXT,
  status        TEXT NOT NULL,       -- 'open'|'settled'|'rejected'
  settle_t      INTEGER,
  payout        REAL,                -- 1*size if won else 0
  pnl           REAL,                -- payout - cost
  order_id      TEXT,                -- live only
  note          TEXT
);
CREATE INDEX idx_trades_window ON trades(window_key);
CREATE INDEX idx_trades_status ON trades(status);
```

## 7. Data sources (concrete)

**Chainlink RTDS** (`wss://ws-live-data.polymarket.com`):
- subscribe: `{"action":"subscribe","subscriptions":[{"topic":"crypto_prices_chainlink","type":"*","filters":""}]}`
- keepalive: send `"PING"` every 5s; ignore `"PONG"`.
- tick msg: `topic:"crypto_prices_chainlink"`, `payload:{symbol, value, timestamp, is_carried_forward}`. Skip `carried` and non-positive for vol (as `realizedVol` does).

**Gamma** (`https://gamma-api.polymarket.com`):
- discover: for each in-scope coin×timeframe, `buildEventSlugCandidates` →
  `GET /events?slug=<candidate>` → pick first live in-window market.
- fields `outcomes` / `outcomePrices` / `clobTokenIds` are JSON-encoded strings
  (parse with `parseJsonArray`); Up/Down by outcome name, positional fallback.
- window start via `getWindowStart`, end via `windowEndFromEventSlug`.

**CLOB** (`https://clob.polymarket.com`): entry pricing via
`client.calculateMarketPrice(tokenId, BUY, amount, FAK)` (already used by
`placeMarketOrder`); optional WS book for tighter mids.

## 8. Strategy (v0)

Deliberately the *current* dashboard signal — nothing new — so dry results are
trustworthy:

```
enter a window IF:
  confidence == 'ok'                         (fresh ticks, tradeable spread)
  AND |modelP - marketP| >= EDGE_THRESHOLD   (default 0.05 = ACTIONABLE_EDGE)
  AND regime != 'panic'                       (the risk gate we built)
  AND ms_remaining ∈ [ENTRY_MIN, ENTRY_MAX]   (timing band; see open Q)
  AND no open trade for this window_key

side  = modelP > marketP ? 'up' : 'down'      (buy the underpriced outcome)
stake = STAKE_USD (clamped to MAX_ORDER_COST)
entry = simulate FAK fill at best ask of chosen side (dry) / real fill (live)
exit  = hold to settle → payout = won ? size : 0 ; pnl = payout - cost
```

- One position per window, no pyramiding.
- v0 holds to resolution (binary settle). Active exit/sell is a later variant
  (the app already has sell logic to borrow from).
- `signal_edge` and `regime_entry` are stored so we can later slice P&L by
  regime and by edge magnitude.

## 9. Executor interface & dry→live

```ts
interface Executor {
  buy(o: { tokenId; side; amountUsd; refAsk; tickSize; negRisk }): Promise<Fill>
}
```
- `dryExecutor`: `Fill = { price: bufferMarketBuyPrice(refAsk, tick), size: amountUsd/price, orderId: null }`. No network. Records `mode:'dry'`.
- `liveExecutor`: calls `placeMarketOrder(...)` from `api/_lib/clob.ts` verbatim,
  returns the real `fillPrice`/`fillSize`. Records `mode:'live'`, `order_id`.

**Promotion gate — live requires ALL of:**
1. `BOT_MODE=live` **and** `--i-understand-live` CLI flag (belt + suspenders).
2. `POLY_PRIVATE_KEY` present and wallet ready (`fetchAccountSnapshot().canTrade`).
3. Guards pass: `guardOrder()` (extracted from `api/orders.ts`) — per-order
   `POLY_MAX_ORDER_COST` / `POLY_MAX_ORDER_SIZE`, live USDC balance check.
4. Bot-level caps: `BOT_MAX_DAILY_TRADES`, `BOT_MAX_CONCURRENT`, `BOT_STAKE_USD`
   small by default.
5. Kill switch: presence of `bot/STOP` file halts new entries immediately.

Dry and live run the *same* strategy/loop; only the executor swaps — so paper
results are a faithful preview.

## 10. Config / env

```
BOT_MODE=dry|live            (default dry)
BOT_COINS=btc,eth,sol,…      (default all in config)
BOT_TIMEFRAMES=5m,15m        (default 5m)
BOT_EDGE_THRESHOLD=0.05
BOT_STAKE_USD=1
BOT_ENTRY_MIN_SEC=20         (don't enter with <20s left … or invert; see Q)
BOT_ENTRY_MAX_SEC=240
BOT_MAX_DAILY_TRADES=50
BOT_MAX_CONCURRENT=5
BOT_DB_PATH=./bot/data.db
# live only — reuse existing:
POLY_ADDRESS, POLY_API_KEY/SECRET/PASSPHRASE, POLY_PRIVATE_KEY,
POLY_FUNDER_ADDRESS, POLY_SIGNATURE_TYPE, POLY_MAX_ORDER_COST, POLY_MAX_ORDER_SIZE
```

## 11. Commands

```
pnpm bot:record   # recorder only (predictions + outcomes + ticks); no trading
pnpm bot:dry      # recorder + dry paper-trader
pnpm bot:live     # recorder + live executor (requires promotion gate)
pnpm bot:report   # SQLite → P&L, hit-rate, Brier (flat/reg/mkt), per-regime, per-edge
pnpm bot:backtest # replay stored ticks through strategy with alt params (M3)
```

## 12. Milestones

- **M1 — Recorder + SQLite. ✅ SHIPPED.** `db.ts`, ported `chainlink.ts`,
  `gamma.ts`, `predict.ts`, write predictions/outcomes/ticks. `bot:record` +
  `bot:report` (Brier flat/reg/mkt + per-regime, mirroring the RegimePanel
  numbers but 24/7 across all coins/TFs). Verified live end-to-end.
- **M2 — Dry paper-trader. ✅ SHIPPED.** `strategy.ts` (late ~T-10s edge entry),
  `executor.ts` (`dryExecutor`), settlement via `db.pendingSettlements`, trades
  table, P&L in `bot:report`. `bot:dry`. *Forward-tested paper P&L, zero orders.*
- **M3 — Backtest/replay. ✅ SHIPPED.** `backtest.ts` replays the M2 entry logic
  over stored predictions+outcomes, sweeping edge threshold × entry timing →
  ROI matrix + ranked combos + per-regime. `bot:backtest` (BT_EDGES / BT_ENTRIES
  / BT_MIN_TRADES). Tunes the strategy on collected data; model-internal tuning
  (vol lookback, regime half-lives) needs a tick-level re-sim — later extension.
- **M4 — Live executor.** `guardOrder()` extraction, `liveExecutor`, promotion
  gate, kill switch. *Deliverable: real trading behind hard guards.*

## 13. Open decisions (need your call)

1. **SQLite driver** — `better-sqlite3` (fast, synchronous, battle-tested; needs
   a native build) **[recommended]** vs `node:sqlite` (built-in Node ≥22.5, no
   dep, still experimental) vs `libsql` client (Turso-compatible, if you ever
   want to sync to cloud later).
2. **Persist raw ticks?** Recommended yes (enables M3 backtesting) — costs disk
   but SQLite handles it. Prunable at 60d like the browser log.
3. **Entry timing band.** Late-window entries (small `ms_remaining`) are more
   accurate but pricier (odds already near 0/1); early entries are cheaper but
   noisier. v0 default is a mid band — this is the #1 thing M3 backtesting
   should tune. Do you want a specific starting policy?
4. **Hold-to-settle vs active exit** for v0 (recommended hold-to-settle; simpler,
   and binary payoff is clean).
5. **Share code via extraction vs direct import.** `api/_lib/clob.ts` reads
   `process.env` and is import-safe today; simplest is direct import. Extracting
   a `packages/core` is cleaner long-term but more churn now (recommended: direct
   import now, extract if it gets messy).
6. **Repo location** — this repo (`bot/` dir, shares deps) vs a sibling repo.
   Recommended: same repo, own entry points; the dashboard and bot share the
   model code and stay in sync.

## 14. Risks

- **RTDS/gamma shape drift** — same brittleness the app already has (slug
  guessing); the bot inherits it. Mitigate with the same `[0,-1,+1,+2]` offset
  probing and loud logging on discovery misses.
- **Paper ≠ live fills** — dry assumes a fill at the buffered ask; real FAK can
  partial-fill or move. M2 records the assumption; M4 compares paper vs realized.
- **Clock/settlement edge** — resolution price = first Chainlink tick at/after
  window end (`firstPriceAtOrAfter`); reuse the app's exact logic to match
  Polymarket resolution.
- **Runaway live trading** — mitigated by dry-default, promotion gate, per-order
  + daily caps, balance check, and the `STOP` kill file.
```
