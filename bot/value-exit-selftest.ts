/**
 * Unit tests for value early-exit logic. Run: `pnpm bot:test-value-exit`
 */
import assert from 'node:assert/strict'
import { loadConfig } from './config'
import { decideValueExit } from './engine/valueExit'
import type { Prediction } from './engine/predict'
import type { ParsedMarket } from '../src/lib/types'

const config = loadConfig()
config.valueExitEnabled = true
config.valueExitMinWinProb = 0.2
config.valueExitWithinSec = 180
config.valueExitMinHoldSec = 60
config.signalSource = 'flat'

const now = 1_000_000
const endMs = now + 120_000 // 2 min left — inside 180s window

function market(overrides: Partial<ParsedMarket> = {}): ParsedMarket {
  return {
    eventSlug: 'btc-updown-5m-1',
    title: 'BTC',
    coin: 'btc',
    timeframe: '5m',
    upPrice: 0.5,
    downPrice: 0.5,
    volume: 0,
    liquidity: 0,
    endDate: new Date(endMs),
    startDate: new Date(now - 180_000),
    upTokenId: 'up',
    downTokenId: 'down',
    bestBidUp: 0.15,
    bestAskUp: 0.17,
    bestBidDown: 0.83,
    bestAskDown: null,
    priceChange1h: null,
    polymarketUrl: '',
    negRisk: false,
    tickSize: 0.01,
    isLive: true,
    inWindow: true,
    priceToBeat: 100,
    ...overrides,
  }
}

function pred(overrides: Partial<Prediction> = {}): Prediction {
  return {
    windowKey: 'w',
    coin: 'btc',
    timeframe: '5m',
    t: now,
    msRemaining: endMs - now,
    spot: 100,
    strike: 100,
    modelP: 0.85,
    regimeP: null,
    regime: 'normal',
    regimeRatio: 1,
    marketP: 0.16,
    upBid: 0.15,
    upAsk: 0.17,
    sigmaWindow: 0.01,
    confidence: 'ok',
    edge: -0.69,
    signal: 'down',
    ...overrides,
  }
}

const pos = { id: 1, side: 'down' as const, size: 2, cost: 1, entryPrice: 0.5, strategy: 'value', entryT: now - 90_000 }

// Down hold, model says P(up)=0.85 → P(down)=0.15 < 0.20, late window, has bid.
assert.ok(
  decideValueExit(pos, pred(), market(), config, now, pos.entryT)?.reason === 'low-prob',
  'cuts when win prob collapses in late window',
)

// Too early in the window (10 min left).
assert.equal(
  decideValueExit(pos, pred(), market({ endDate: new Date(now + 600_000) }), config, now, pos.entryT),
  null,
  'no cut when outside late window',
)

// Still likely to win.
assert.equal(
  decideValueExit(
    { ...pos, side: 'up' },
    pred({ modelP: 0.75 }),
    market({ bestBidUp: 0.74, bestAskUp: 0.76 }),
    config,
    now,
    pos.entryT,
  ),
  null,
  'no cut when P(win) above threshold',
)

// Min hold not met.
assert.equal(
  decideValueExit(pos, pred(), market(), config, now, now - 10_000),
  null,
  'no low-prob cut before min hold',
)

// Panic exits even before min hold.
assert.ok(
  decideValueExit(pos, pred({ regime: 'panic' }), market(), config, now, now - 5_000)?.reason ===
    'regime-panic',
  'panic exit ignores min hold',
)

// Disabled.
config.valueExitEnabled = false
assert.equal(decideValueExit(pos, pred(), market(), config, now, pos.entryT), null, 'off when disabled')
config.valueExitEnabled = true

// No bid — wait (not panic).
assert.equal(
  decideValueExit(pos, pred(), market({ bestBidUp: null, bestAskUp: null }), config, now, pos.entryT),
  null,
  'no low-prob cut without a bid',
)

// Bad confidence — don't trust the model for a cut.
assert.equal(
  decideValueExit(pos, pred({ confidence: 'stale' }), market(), config, now, pos.entryT),
  null,
  'no cut when confidence not ok',
)

console.info('value-exit self-test: PASS')
process.exit(0)
