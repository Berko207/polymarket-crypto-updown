/**
 * Deterministic self-test for the maker fill model + quoting (Phase 1 acceptance,
 * docs/maker-paper-strategy.md §14). No test runner in this repo, so this is a
 * plain assert script: `pnpm bot:test-maker` (exit 0 = pass, 1 = fail).
 *
 * Guards the invariants that keep the sim honest:
 *   §14.1 no L0 — a resting order fills ONLY on a trade printing through its price.
 *   §14.2 fill price is ALWAYS the resting order's quoted price.
 *   §14.3 L2 (queue-ahead) fill rate is strictly lower than L1 on the same tape.
 */
import assert from 'node:assert/strict'
import { MakerSimExecutor, type MakerFill } from './engine/makerExecutor'
import { decideQuotes, microprice, type MakerContext } from './engine/maker'
import { emptyAccount, applyFill, flatten, settle } from './engine/makerAccount'
import { loadConfig } from './config'
import { openDb } from './db'
import type { TradePrint, TokenBook } from './sources/clobMarket'
import type { Prediction } from './engine/predict'

const t0 = 1_000
const trade = (price: number, size: number | null, side: TradePrint['side'], ts: number): TradePrint => ({
  price,
  size,
  side,
  ts,
})
const tape = (token: string, prints: TradePrint[]): Map<string, TradePrint[]> => new Map([[token, prints]])

function testFillModel(): void {
  const ex = new MakerSimExecutor({ fillModel: 'L1', rebateRate: 0.01 })
  ex.post({ windowKey: 'w', side: 'up', tokenId: 'T', price: 0.6, size: 10 }, t0)

  // §14.1: a print ABOVE our bid is not a trade-through — no fill (no L0 touch-fill).
  assert.equal(ex.step(tape('T', [trade(0.65, 5, 'sell', t0 + 1)])).length, 0, 'no fill above bid')
  // A trade that predates the order can't fill it.
  assert.equal(ex.step(tape('T', [trade(0.55, 5, 'sell', t0 - 10)])).length, 0, 'no fill pre-post')
  // A known taker BUY lifts asks, not our bid — excluded.
  assert.equal(ex.step(tape('T', [trade(0.6, 5, 'buy', t0 + 2)])).length, 0, 'taker buy excluded')

  // A sell at our bid for size 4 → partial fill of 4 at the QUOTED price (§14.2).
  const f1 = ex.step(tape('T', [trade(0.6, 4, 'sell', t0 + 3)]))
  assert.equal(f1.length, 1, 'one fill')
  assert.equal(f1[0].price, 0.6, 'fill price == quote price')
  assert.equal(f1[0].size, 4, 'partial fill size')
  assert.ok(Math.abs(f1[0].rebate - 0.04) < 1e-9, 'rebate == rate*size')

  // A big sell below the bid fills the remaining 6, still at 0.60, and removes the order.
  const f2 = ex.step(tape('T', [trade(0.5, 100, 'sell', t0 + 4)]))
  assert.equal(f2.length, 1, 'remainder fills')
  assert.equal(f2[0].price, 0.6, 'fill price invariant on trade-through below')
  assert.equal(f2[0].size, 6, 'remainder size')
  assert.equal(ex.open().length, 0, 'fully filled order removed')
  assert.equal(ex.step(tape('T', [trade(0.5, 100, 'sell', t0 + 5)])).length, 0, 'nothing left to fill')
}

function testQueuePriority(): void {
  // §14.3: same tape, L2 (5 ahead) must fill strictly less than L1 (front of queue).
  const l2 = new MakerSimExecutor({ fillModel: 'L2', rebateRate: 0 })
  l2.post({ windowKey: 'w', side: 'up', tokenId: 'T', price: 0.6, size: 10 }, t0, 5)
  const fL2 = l2.step(tape('T', [trade(0.6, 8, 'sell', t0 + 1)]))
  assert.equal(fL2[0].size, 3, 'L2 consumes 5 queue-ahead, fills 3 of the 8')

  const l1 = new MakerSimExecutor({ fillModel: 'L1', rebateRate: 0 })
  l1.post({ windowKey: 'w', side: 'up', tokenId: 'T', price: 0.6, size: 10 }, t0, 5) // qAhead ignored under L1
  const fL1 = l1.step(tape('T', [trade(0.6, 8, 'sell', t0 + 1)]))
  assert.equal(fL1[0].size, 8, 'L1 ignores the queue')
  assert.ok(fL2[0].size < fL1[0].size, 'L2 fill rate strictly lower than L1')
}

function testQuoting(): void {
  const config = loadConfig()
  const upBook: TokenBook = { bestBid: 0.48, bestAsk: 0.52, bids: [{ price: 0.48, size: 100 }], asks: [{ price: 0.52, size: 100 }] }
  const downBook: TokenBook = { bestBid: 0.48, bestAsk: 0.52, bids: [{ price: 0.48, size: 100 }], asks: [{ price: 0.52, size: 100 }] }
  const pred: Prediction = {
    windowKey: 'w', coin: 'btc', timeframe: '15m', t: 0, msRemaining: 600_000,
    spot: 100, strike: 100, modelP: 0.5, regimeP: null, regime: 'normal', regimeRatio: null,
    marketP: 0.5, upBid: 0.48, upAsk: 0.52, sigmaWindow: 0.02, confidence: 'ok', edge: 0, signal: null,
  }
  const ctx: MakerContext = {
    pred, upBook, downBook, upTokenId: 'U', downTokenId: 'D', tickSize: 0.01, msRemaining: 600_000,
  }
  const quotes = decideQuotes(ctx, { upShares: 0, downShares: 0 }, config)
  assert.equal(quotes.length, 2, 'two-sided quote when flat and mid-book')
  const up = quotes.find((q) => q.side === 'up')
  const down = quotes.find((q) => q.side === 'down')
  assert.ok(up && down, 'both an up and a down quote')
  // Both must be passive (strictly inside their book's best ask).
  assert.ok(up!.price < upBook.bestAsk!, 'up bid is passive')
  assert.ok(down!.price < downBook.bestAsk!, 'down bid is passive')
  // With fv=0.50 and half-spread 0.03, the up bid sits ~0.47.
  assert.ok(Math.abs(up!.price - 0.47) < 1e-9, 'up bid at fv − spread')

  // Inside the pull window → no quotes.
  assert.equal(
    decideQuotes({ ...ctx, msRemaining: (config.makerPullSec - 1) * 1_000 }, { upShares: 0, downShares: 0 }, config).length,
    0,
    'quotes pulled near the boundary',
  )
  // Non-ok confidence → no quotes.
  assert.equal(
    decideQuotes({ ...ctx, pred: { ...pred, confidence: 'stale' } }, { upShares: 0, downShares: 0 }, config).length,
    0,
    'no quotes when confidence not ok',
  )
  // Microprice reflects book pressure: a heavier bid (buy pressure) pulls it toward the ask.
  const skewed: TokenBook = { bestBid: 0.48, bestAsk: 0.52, bids: [{ price: 0.48, size: 300 }], asks: [{ price: 0.52, size: 100 }] }
  const mp = microprice(skewed)
  assert.ok(mp != null && mp > 0.5, 'microprice pulled toward the ask by heavier bid size (buy pressure)')
}

const mkFill = (side: 'up' | 'down', price: number, size: number, rebate: number): MakerFill => ({
  orderId: 'x',
  windowKey: 'w',
  side,
  tokenId: side === 'up' ? 'U' : 'D',
  price,
  size,
  rebate,
  t: 1,
})

function testSettlement(): void {
  // A: both sides fill and hold to settlement — a locked hedge + rebate (§10, §14.5).
  {
    const acct = emptyAccount()
    const inv = { upShares: 0, downShares: 0 }
    applyFill(acct, inv, mkFill('up', 0.48, 10, 0.05))
    applyFill(acct, inv, mkFill('down', 0.49, 10, 0.05))
    assert.equal(inv.upShares, 10)
    assert.equal(inv.downShares, 10)
    assert.ok(Math.abs(acct.cashSpent - 9.7) < 1e-9, 'cash = 4.8 + 4.9')
    assert.ok(Math.abs(acct.rebate - 0.1) < 1e-9, 'rebate accrues on both fills')
    const up = settle(acct, inv, 'up')
    assert.ok(Math.abs(up.payout - 10.1) < 1e-9, 'payout = rebate 0.10 + 10 winning shares')
    assert.ok(Math.abs(up.pnl - 0.4) < 1e-9, 'hedged $10 pair for 9.7 + 0.10 rebate = +0.40')
    assert.ok(Math.abs(up.payout - up.cost - acct.fees - up.pnl) < 1e-9, 'reconciles: payout − cost − fees == pnl')
    const down = settle(acct, inv, 'down')
    assert.ok(Math.abs(down.pnl - 0.4) < 1e-9, 'fully hedged → identical pnl either outcome')
  }
  // B: one side fills, flattened before close — books the taker fee (§14.5 cost completeness).
  {
    const acct = emptyAccount()
    const inv = { upShares: 0, downShares: 0 }
    applyFill(acct, inv, mkFill('up', 0.48, 10, 0.05))
    const leg = flatten(acct, inv, 0.52, 0.07, true)
    assert.ok(leg && leg.side === 'up' && leg.qty === 10, 'flatten sells the net long')
    assert.equal(inv.upShares, 0, 'inventory flat after flatten')
    const expectFee = 0.07 * 0.52 * 0.48 * 10
    assert.ok(Math.abs(acct.fees - expectFee) < 1e-9, 'flatten books the parabolic taker fee')
    const s = settle(acct, inv, 'down') // residual 0 → settlement 0
    const expectPnl = 0.05 + 0.52 * 10 - 0.48 * 10 - expectFee
    assert.ok(Math.abs(s.pnl - expectPnl) < 1e-9, 'pnl = spread + rebate − fee')
    assert.ok(Math.abs(s.payout - s.cost - acct.fees - s.pnl) < 1e-9, 'reconciles')
  }
  // C: no book to flatten into → residual rides to $1/$0 settlement (a loser).
  {
    const acct = emptyAccount()
    const inv = { upShares: 0, downShares: 0 }
    applyFill(acct, inv, mkFill('up', 0.6, 10, 0))
    assert.equal(flatten(acct, inv, null, 0.07, true), null, 'no bid → nothing flattened')
    const s = settle(acct, inv, 'down')
    assert.equal(s.payout, 0, 'losing residual pays 0')
    assert.ok(Math.abs(s.pnl + 6.0) < 1e-9, 'lost the $6 staked')
  }
}

function testLedgerDb(): void {
  // Persist a full window through the real DB and confirm the summaries reconcile.
  const db = openDb(':memory:')
  db.insertMakerFill({ windowKey: 'w', coin: 'btc', timeframe: '15m', mode: 'dry', tokenSide: 'up', fillT: 1, price: 0.48, size: 10, rebate: 0.05, fillModel: 'L1', orderId: 'a' })
  db.insertMakerFill({ windowKey: 'w', coin: 'btc', timeframe: '15m', mode: 'dry', tokenSide: 'down', fillT: 2, price: 0.49, size: 10, rebate: 0.05, fillModel: 'L1', orderId: 'b' })
  db.insertMakerTrade({ windowKey: 'w', coin: 'btc', timeframe: '15m', mode: 'dry', side: 'up', entryT: 1, entryPrice: 0.485, size: 20, cost: 9.7, entryFee: 0, regimeEntry: 'normal', settleT: 3, payout: 10.1, pnl: 0.4 })
  const n = (db.raw.prepare('SELECT COUNT(*) AS n FROM maker_fills').get() as { n: number }).n
  assert.equal(n, 2, 'both fills persisted to the ledger')
  const sum = db.tradeSummaryForMode('dry')
  assert.equal(sum.entered, 1, 'one settled maker trade in the summary')
  assert.equal(sum.wins, 1, 'positive pnl counts as a win')
  assert.ok(Math.abs(sum.staked - 9.7) < 1e-9, 'summary staked == cost')
  assert.ok(Math.abs(sum.pnl - 0.4) < 1e-9, 'summary pnl reconciles')
  db.close()
}

try {
  testFillModel()
  testQueuePriority()
  testQuoting()
  testSettlement()
  testLedgerDb()
  console.info('maker self-test: PASS (fill model §14.1–3 + quoting + settlement/flatten §14.5 + ledger DB)')
  process.exit(0)
} catch (e) {
  console.error('maker self-test: FAIL —', e instanceof Error ? e.message : e)
  process.exit(1)
}
