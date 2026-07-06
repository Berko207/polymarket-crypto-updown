# Maker paper-strategy — design spec

Status: **proposal** · Author: research/desk-note follow-up · Scope: `bot/` paper (dry) mode
Related: `docs/bot-plan.md`, the "what am I missing" desk note (maker thesis), memory `[[desk-note-missing-out]]`, `[[sell-empty-book-tools]]` (optimistic-fill trap).

---

## 0. TL;DR

Add a third `BOT_STRATEGY=maker` that **posts two-sided passive limit quotes** around the Φ(d₂) fair value instead of crossing the spread. It exists to test the desk-note thesis: on short-dated crypto up/down, the taker edge is structurally dead (parabolic fee + slippage), and the surviving edge is *making* — capturing the spread, dodging the taker fee, and (if the program pays) collecting the USDC maker rebate.

The hard part is **not** the quoting math — it's **honestly simulating resting-limit fills** without real orders. A naive "my quote fills when the mid touches it" model is the optimistic-fill trap that already burned the resting-sell work; it would make maker P&L look free. This spec centers the fill model and makes it the acceptance gate.

Two things must land before any quoting logic is worth writing:
- **Feed upgrade (Phase 0):** the bot only has gamma top-of-book today. Maker-fill sim needs **trade prints + book depth** → a Node CLOB-market-WS source.
- **Executor rework:** the current `Executor.buy/sell` fills synchronously on submit. A maker order **rests → (partially) fills → cancels/expires**. That lifecycle is new.

---

## 1. Objective & thesis

**Goal:** a paper strategy that quantifies whether passive market-making on our exact markets (BTC/ETH/SOL/XRP · 15m/1h/4h) is net-positive after honest costs, using the model we already have as the fair-value anchor.

**Why maker (recap):** `fees.ts` already models the taker cost as `feeRate·p·(1−p)·shares`, peaking at 50¢ — exactly where these markets live. Every taker fill pays that plus half-spread. A maker:
- **earns** the half-spread instead of paying it,
- **pays no taker fee** (`fees.ts`: sells exempt, makers pay zero fee),
- **may earn** a rebate (see §11 open question — treat as upside, not the thesis).

Maker P&L ≈ `spread_capture + rebate − adverse_selection − flatten_cost − unflattened_settlement_variance`. The edge over our swing/value takers is that the first two terms are *positive* where the taker's fee term is *negative*.

**Our advantage over generic MM bots** (poly-maker, polymarket-terminal): they anchor fair value on a depth-weighted microprice off the book. We have a *model* (`predict.ts` flat/regime Φ(d₂)). The maker strategy should anchor on `sourceProb()` and optionally blend the microprice — a model-anchored quote is the differentiator.

---

## 2. The core challenge: honest fill modeling

A resting BUY limit at price `p` only fills when someone **sells into it** — i.e. a trade prints at ≤ `p` — and only for size that reaches *your* place in the queue. Three fidelity levels:

| Level | Rule | Needs | Verdict |
|---|---|---|---|
| **L0 — touch** | Quote fills when mid/last touches its price. | top-of-book only | **Banned.** This is the optimistic-fill trap. Overstates fills, ignores queue, invents free spread. Do not ship. |
| **L1 — trade-through** | Resting BUY@p fills for `min(quoteSize, tradedSize)` when a trade prints at price ≤ p (SELL@p symmetric for ≥ p). | trade prints (price+size+side) | Minimum honest bar. Ignores queue priority (optimistic on fill *rate*, not on fill *price*). |
| **L2 — trade-through + queue** | Track `qAhead` = resting size at your level when you posted. A trade at your level first consumes `qAhead`; you fill only the remainder. Repricing resets `qAhead`. | trade prints **and** L2 book depth | **Target.** Queue priority is the whole game for rebate farming; without it the sim rewards quoting you'd never win. |

**Decision:** ship **L1 as the correctness floor** and **L2 as the default** once depth is wired. Every P&L number the dashboard shows must carry the fill-model level so we never mistake an L0/L1 approximation for reality. `makerFillModel` is a config knob.

---

## 3. Prerequisite — Phase 0: feed upgrade

Today the bot's only book signal is `market.bestBidUp/bestAskUp` from `fetchCurrentMarket` (gamma REST, polled `marketPollMs`=5s / `swingOpenPollMs`=2s). That is insufficient for L1/L2: no trade prints, no depth, and 2–5s is far coarser than fills happen.

**Add `bot/sources/clobMarket.ts`** — a Node port of the browser `src/lib/clobSocket.ts` singleton, subscribing the tradable tokens to `wss://ws-subscriptions-clob.polymarket.com/ws/market`. Consume:
- `book` — full depth snapshot → maintain a local order book per token (level → size).
- `price_change` — incremental depth updates.
- `last_trade_price` (and/or trade messages) — the **trade tape**: `{price, size, side, ts}` per token. This is the fill trigger.

Expose to the loop: `bookDepth(tokenId)`, `tradesSince(tokenId, sinceMs)`, `connected`. Reuse the reconnect/watchdog pattern already in `clobSocket.ts` and `chainlinkSocket.ts`.

> This module is independently useful — it also solves the desk-note "no execution-quality metrics" gap (effective spread, queue depth) and is a step toward the `polyrec`-style offline recorder.

---

## 4. Architecture

Mirror the swing pattern: **pure decision functions** in `bot/engine/maker.ts`, **state in SQLite + in-memory maps**, driven from the `index.ts` tick loop. New pieces:

```
bot/engine/maker.ts        # quoting math + requote/cancel decisions (pure)
bot/engine/makerExecutor.ts# resting-order lifecycle + fill sim (dry) / real GTC post-only (live, deferred)
bot/engine/makerFees.ts    # makerRebate(price, shares, rate); reuse fees.takerFee for flatten leg
bot/sources/clobMarket.ts  # Phase 0 feed (depth + trade tape)
```

### 4.1 Executor rework

The current `Executor { buy(order): Promise<Fill>; sell(order): Promise<Fill> }` fills on submit. Extend, do **not** overload, so value/swing are untouched:

```ts
export interface MakerQuote {
  windowKey: string
  tokenId: string          // YES/Up token; NO side posts on downTokenId
  side: 'up' | 'down'      // which token this quote buys (see §5.3 two-sided mapping)
  price: number            // limit price, tick-aligned, post-only
  size: number             // shares
  tickSize: number | null
  negRisk: boolean | null
}

export interface RestingOrder extends MakerQuote {
  id: string               // sim-local id (or CLOB orderId when live)
  postedT: number
  qAhead: number           // L2 queue-ahead size at post time (0 for L1)
  filled: number           // cumulative filled shares
}

export interface MakerExecutor {
  post(q: MakerQuote): Promise<RestingOrder>
  cancel(id: string): Promise<void>
  /** Advance sim against the trade tape since last step; returns fills produced. */
  step(now: number, tape: TradePrint[], book: BookDepth): MakerFill[]
  open(): RestingOrder[]
}
```

The **dry** `makerExecutor` is a pure simulator (§7). The **live** executor (deferred, not in first cut) posts real **GTC post-only** orders via `api/_lib/clob` (`placeLimitOrder` already exists) and reconciles fills from the user WS. Keeping the interface separate means the loop code is identical dry/live, same as `dryExecutor`/`makeLiveExecutor` today.

### 4.2 Loop integration (`index.ts`)

Add a `config.strategy === 'maker'` branch alongside the `swing` branch in `sampleScope`. Per tradable window each tick:
1. `makerExec.step()` against `clobMarket.tradesSince()` → realize fills → update inventory + persist.
2. `manageMakerBoundary()` — pull/flatten near close (§8).
3. `decideQuotes(pred, book, inventory, config, now)` → desired two-sided quotes → diff against `makerExec.open()` → cancel/replace only what moved (§6).

`setStrategy` must accept `'maker'` (currently `'value' | 'swing'`); a switch to/from maker force-cancels resting quotes and flattens inventory via the existing `requestCloseAllOpen` drain.

---

## 5. Quoting model

All prices from the **Up/YES** token's perspective; `deriveBook` already gives the complement for Down.

### 5.1 Fair-value anchor
`FV = w_model · sourceProb(pred, signalSource) + (1 − w_model) · microprice`, where `microprice = (bestBid·askSize + bestAsk·bidSize)/(bidSize+askSize)` from the L2 book. Default `w_model = 1.0` (pure model) so we test the model-anchored thesis first; `makerMicropriceWeight` exposes the blend.

### 5.2 Reservation price (inventory skew)
Avellaneda–Stoikov-lite. With signed net YES inventory `q` (shares), window variance `σ²=varPerMs·msRemaining`, normalized to cap `qMax = makerMaxInventory`:

```
r = FV − makerInvSkew · (q / qMax)          # long YES ⇒ skew quotes down to shed
```

Skew both quotes down when long YES, up when short — biases fills toward flattening.

### 5.3 Half-spread and two-sided posting
```
δ = makerBaseSpread + makerVolCoef · sigmaWindow + makerToxCoef · toxicity   (§9)
```
Post two passive quotes (the rebate-farming double-sided pattern):
- **Bid (accumulate YES):** BUY **Up** @ `r − δ`.
- **Ask (shed YES ≡ accumulate NO):** BUY **Down** @ `1 − (r + δ)`  (selling YES at `r+δ` ≡ buying NO at `1−(r+δ)`).

When both fill evenly, net `q≈0`, total paid `≈ 1 − 2δ` for a guaranteed $1 → locked `≈ 2δ` minus fees plus rebate. Clamp both prices to `[tick, 1−tick]`, align to `tickSize`, enforce post-only (never cross best — if `r−δ ≥ bestAsk`, pull the bid).

### 5.4 Sizing
`clip = makerClipUsd / price` shares, scaled by remaining inventory room on that side: `size_bid = clip · clamp((qMax − q)/qMax, 0, 1)`, symmetric for ask. A side at its inventory cap posts nothing.

---

## 6. Order lifecycle & requoting

Each tick, compute desired quotes and diff vs resting:
- **Keep** a resting quote if its price is within `makerRequoteTick` of desired (avoid churn).
- **Cancel-replace** if desired price moved beyond that, if FV moved > `makerRequoteEdge`, or if it's stale > `makerQuoteTtlSec`.
- **Rate-limit** requotes to `makerMinRequoteMs` per side (real MM constraint; also keeps the sim from repricing every tick).

**Queue-priority cost:** every cancel-replace resets `qAhead` to the current resting size at the new level — modeled explicitly so the sim penalizes over-requoting exactly as reality does. This is a core realism feature, not an optimization.

---

## 7. Fill simulation (dry executor)

`step(now, tape, book)` per resting order `o`:

```
for each trade print t in tape (since last step), for token o.tokenId:
  if o is a BUY and t.side == SELL and t.price <= o.price:      # someone sold into our bid
     avail = t.size
     if o.qAhead > 0:                                           # L2: consume queue ahead first
        consumed = min(o.qAhead, avail); o.qAhead -= consumed; avail -= consumed
     fillQty = min(avail, o.size - o.filled)
     if fillQty > 0: emit MakerFill{ price:o.price, size:fillQty, rebate: makerRebate(o.price, fillQty) }
                     o.filled += fillQty
  (L1: skip the qAhead block entirely)
```

Notes:
- Fill **price is our quoted price**, never the touch — we were passive.
- **Partial fills** are the norm; `o.size − o.filled` remains resting.
- A fully-filled order is removed; a partial stays with reduced remaining and preserved (decremented) `qAhead`.
- **Adverse selection falls out for free:** if our bid fills and the very next prints/model move down, the mark-to-market immediately shows the loss — no special-casing.
- Every `MakerFill` updates net inventory `q` and appends to a `maker_fills` ledger (§12).

---

## 8. Boundary & inventory management

Short windows mean the "stop quoting near resolution" advice maps to seconds:
- **Widen** δ linearly once `msRemaining < makerWidenSec`.
- **Pull** all quotes once `msRemaining < makerPullSec` (default e.g. 20s) — no new inventory into the settlement blip.
- **Flatten** residual `q` at `msRemaining == makerFlattenSec`: cross the spread with a marketable order (reuse the taker path + `takerFee` for the flatten leg — this is the one place the maker strategy pays taker cost, and it must be booked). Alternative `makerLetRide=1` holds to $0/$1 settlement (higher variance; for A/B).

**Inventory cap / kill switch:** hard `makerMaxInventory` (net shares). On breach, stop quoting the side that increases `|q|` and flatten immediately. Feeds the portfolio-risk layer from the desk-note roadmap.

---

## 9. Adverse selection / toxicity

`toxicity` = EWMA of signed trade flow from the tape (`+size` on buys, `−size` on sells), normalized. High one-sided flow ⇒ informed traders ⇒ **widen** δ (via `makerToxCoef`) and optionally pull the side being run over. This is the single biggest reason naive makers bleed (odds gap 40–50pts on news); the tape-driven toxicity signal is our defense and is only possible because Phase 0 gives us trades.

---

## 10. P&L accounting

Extend the paper ledger honestly:
- **Per fill:** cash `−price·size` (BUY), inventory `+size` on that token; **`+ makerRebate`** (income, may be 0).
- **No taker fee on maker fills.**
- **Flatten leg:** marketable → pays `takerFee` (booked as cost) at the crossed price.
- **Settlement:** any residual inventory settles $1/$0 via existing `settleTrades`.
- **Reported metrics:** realized spread capture, rebate earned, adverse-selection cost (fill-to-next-mark drift), flatten cost, fill rate (filled/quoted), effective queue wait, net P&L — all tagged with `makerFillModel` level.

Maker positions don't fit the one-row-per-trade `trades` model cleanly (many fills, two sides, net inventory). Use a **fills ledger** (§12) and synthesize round-trip/close rows for the existing history grid.

---

## 11. Config knobs (`BOT_MAKER_*`)

Follow `config.ts` conventions (`num`/`numNonNeg`, `BOT_*` env, runtime-adjustable via control server):

| Knob | Env | Default | Meaning |
|---|---|---|---|
| `makerFillModel` | `BOT_MAKER_FILL_MODEL` | `L2` | `L1`/`L2` fill fidelity. |
| `makerBaseSpread` | `BOT_MAKER_BASE_SPREAD` | `0.02` | Half-spread floor (pts). |
| `makerVolCoef` | `BOT_MAKER_VOL_COEF` | `0.5` | Widen per unit `sigmaWindow`. |
| `makerToxCoef` | `BOT_MAKER_TOX_COEF` | `0.3` | Widen per unit toxicity. |
| `makerInvSkew` | `BOT_MAKER_INV_SKEW` | `0.02` | Reservation-price skew at full inventory. |
| `makerClipUsd` | `BOT_MAKER_CLIP_USD` | `1` | Notional per quote. |
| `makerMaxInventory` | `BOT_MAKER_MAX_INVENTORY` | `20` | Net-share cap / kill trigger. |
| `makerMicropriceWeight`| `BOT_MAKER_MICROPRICE_WEIGHT` | `0` | Blend microprice into FV. |
| `makerRebateRate` | `BOT_MAKER_REBATE_RATE` | `0` | **Rebate per share — see open Q1.** |
| `makerRequoteEdge` | `BOT_MAKER_REQUOTE_EDGE` | `0.01` | FV move that forces a requote. |
| `makerMinRequoteMs` | `BOT_MAKER_MIN_REQUOTE_MS` | `1500` | Requote rate-limit per side. |
| `makerQuoteTtlSec` | `BOT_MAKER_QUOTE_TTL_SEC` | `30` | Stale-quote cancel. |
| `makerWidenSec` / `makerPullSec` / `makerFlattenSec` | … | `60/20/15` | Boundary schedule. |
| `makerLetRide` | `BOT_MAKER_LET_RIDE` | `0` | Hold residual to settlement instead of flattening. |

Reuse existing `signalSource`, `swingSkipCalm`-style regime gates, `stakeUsd`→clip, `maxConcurrent`→max windows quoted.

---

## 12. DB changes

Additive only (same `addColumn` migration pattern as the swing rollout). Add a **fills ledger**:

```sql
CREATE TABLE IF NOT EXISTS maker_fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  window_key TEXT NOT NULL, coin TEXT, timeframe TEXT, mode TEXT,
  token_side TEXT NOT NULL,          -- 'up' | 'down'
  fill_t INTEGER NOT NULL, price REAL NOT NULL, size REAL NOT NULL,
  rebate REAL NOT NULL DEFAULT 0, fill_model TEXT NOT NULL,
  order_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_makerfills_window ON maker_fills(window_key);
```
Keep synthesizing `trades` rows (strategy `'maker'`) at window close for the existing summary/history/monitor queries, computing net P&L from the ledger + settlement + flatten. `tradeSummaryForMode`, `queryTrades`, `recentClosed` then work unchanged.

---

## 13. Dashboard surface

- `BotControlPanel.tsx`: add **Maker** to the Value/Swing strategy switch; expose the top knobs (base spread, clip, max inventory, fill-model badge).
- `BotMonitorPanel.tsx`: a maker view — live **net inventory** per window, **resting quotes** (bid/ask/size), **fill rate**, **spread captured vs rebate vs adverse-selection**, and a prominent **fill-model tag** so an L1 number is never read as ground truth.
- Control-server `getStatus` gains `makerInventory`, `restingQuotes`, `makerMetrics`.

---

## 14. Validation / acceptance criteria

The sim is only useful if it's honest. Gate merge on:
1. **No L0 anywhere** — grep-proof; fills only ever originate from a trade print in the tape.
2. **Fill-price invariant:** every maker fill price equals its quoted price (never the touch/opposite side).
3. **Queue sanity (L2):** with `qAhead` seeded from real depth, fill rate must be *strictly lower* than L1 on the same tape (unit test on a captured tape).
4. **Requote penalty:** a config that requotes every tick must show *lower* fill rate than a patient one (queue reset works).
5. **Cost completeness:** flatten legs book `takerFee`; unflattened inventory books settlement P&L; totals reconcile to the ledger.
6. **Reality check:** run dry for ≥1 week across 15m/1h/4h; if maker net P&L is positive **only** under `makerRebateRate>0`, the honest conclusion is "needs the rebate" (see Q1) — report it, don't bury it.

Capture a real trade tape (Phase 0 recorder) for a few windows and commit it as a fixture so the fill model is unit-tested deterministically (also fills the project's "no tests" gap for this module).

---

## 15. Phased build plan

| Phase | Deliverable | Effort | Gate |
|---|---|---|---|
| **0** | `bot/sources/clobMarket.ts` — depth + trade tape; log-only, verify against dashboard book. | M | Trades/depth stream stably; recorded fixture captured. |
| **1** | `makerExecutor` (dry) L1 + `maker.ts` quoting; wire `strategy='maker'` branch; `maker_fills` ledger; basic P&L. | L | Acceptance §14.1–2, 5. |
| **2** | L2 queue model; toxicity; inventory skew + cap/kill; boundary schedule. | M | Acceptance §14.3–4. |
| **3** | Dashboard maker view + control knobs + strategy switch. | M | Operable from UI. |
| **4** | Week-long dry A/B vs swing on same windows; write up whether maker clears costs. | — | Decision: pursue live GTC post-only, or shelve. |
| **5** *(deferred)* | Live `makerExecutor` via `placeLimitOrder` (GTC post-only) + user-WS fill reconcile, behind the existing live-arming gates. | L | Only if Phase 4 is positive. |

---

## 16. Risks & open questions

1. **Q1 — does the maker rebate actually pay on crypto up/down, and how much?** `fees.ts` says "makers paid zero"; the research says dynamic fees fund USDC rebates. **This gates the whole thesis's upside.** Action: confirm the current program from Polymarket docs before trusting any rebate-positive result. The strategy is built to be *evaluated at `makerRebateRate=0`* first, so a real edge must show from spread + fee-avoidance alone; the rebate is gravy.
2. **Fill realism ceiling.** Even L2 can't model other makers' cancels or hidden queue reshuffling. It is a *conservative approximation of fill rate*; label it as such. Never present sim maker P&L with taker-level confidence.
3. **Feed latency.** A 2–5s gamma cadence is useless here; correctness depends on the WS tape actually being live. Watchdog + a "stale feed ⇒ pull quotes" guard are mandatory.
4. **Two-sided inventory blow-ups on trend.** A one-way market fills only one side repeatedly → inventory runs → the cap/kill and toxicity widening must be real, not TODOs.
5. **Live execution is a different beast** (queue priority, cancel latency, post-only rejects) — explicitly out of first scope; Phase 5, gated on a positive paper result.

---

### Appendix — why this can't reuse `dryExecutor`

`dryExecutor.buy` returns `{ fillPrice: order.fillPrice, fillSize: stakeUsd/fillPrice }` immediately — it *assumes* a taker cross. A maker order has no fill at submit; its fills arrive asynchronously from the tape and are usually partial. Forcing maker through that interface would silently reintroduce L0. Hence the separate `MakerExecutor` with `post`/`step`/`cancel`.
