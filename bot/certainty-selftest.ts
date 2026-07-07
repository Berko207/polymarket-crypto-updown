/**
 * Easy-mode entry gates — blocks phantom edge from strike/book mismatch.
 * Run: pnpm bot:test-certainty
 */
import assert from 'node:assert/strict'
import { loadConfig } from './config'
import {
  certaintyStrike,
  evaluateCertainty,
  oracleFavoredSide,
} from './engine/certainty'
import type { Prediction } from './engine/predict'
import type { ParsedMarket } from '../src/lib/types'

function basePred(overrides: Partial<Prediction> = {}): Prediction {
  return {
    windowKey: 'w',
    coin: 'xrp',
    timeframe: '15m',
    t: 0,
    msRemaining: 20_000,
    spot: 1.13,
    strike: 1.12,
    modelP: 0.99,
    regimeP: null,
    regime: 'normal',
    regimeRatio: null,
    marketP: 0.5,
    upBid: 0.48,
    upAsk: 0.52,
    sigmaWindow: 0.02,
    confidence: 'ok',
    edge: 0,
    signal: null,
    ...overrides,
  }
}

function baseMarket(overrides: Partial<ParsedMarket> = {}): ParsedMarket {
  return {
    eventSlug: 'xrp-updown-15m-123',
    title: 'XRP',
    coin: 'xrp',
    timeframe: '15m',
    upPrice: 0.08,
    downPrice: 0.92,
    volume: 0,
    liquidity: 0,
    endDate: new Date(Date.now() + 20_000),
    startDate: new Date(Date.now() - 880_000),
    upTokenId: 'up-tok',
    downTokenId: 'down-tok',
    bestBidUp: 0.07,
    bestAskUp: 0.08,
    bestBidDown: null,
    bestAskDown: null,
    priceChange1h: null,
    polymarketUrl: '',
    negRisk: false,
    tickSize: 0.01,
    isLive: true,
    inWindow: true,
    priceToBeat: 1.12,
    ...overrides,
  }
}

function testStrikePrefersPriceToBeat(): void {
  const market = baseMarket({ priceToBeat: 100 })
  assert.equal(certaintyStrike(market, 99.5), 100)
  assert.equal(certaintyStrike(baseMarket({ priceToBeat: null }), 99.5), 99.5)
}

function testRejectsCheapFavoredAsk(): void {
  const config = loadConfig()
  config.strategy = 'certainty'
  config.certaintyMinZ = 0
  const pred = basePred()
  const market = baseMarket()
  const spot = 1.13
  const strike = 1.12
  assert.equal(oracleFavoredSide(spot, strike), 'up')
  const ev = evaluateCertainty(pred, market, spot, strike, config, Date.now(), {
    clobAsk: 0.08,
    clobOppAsk: 0.92,
    requireClobAsk: true,
  })
  assert.equal(ev.ok, false)
  assert.match(ev.reason ?? '', /market disagrees|favored ask/)
}

function testRejectsPhantomEdge(): void {
  const config = loadConfig()
  config.strategy = 'certainty'
  config.certaintyMinZ = 0
  config.certaintyMinFavoredAsk = 0.5
  const ev = evaluateCertainty(basePred(), baseMarket(), 1.13, 1.12, config, Date.now(), {
    clobAsk: 0.52,
    clobOppAsk: 0.48,
    requireClobAsk: true,
  })
  assert.equal(ev.ok, false)
  assert.match(ev.reason ?? '', /edge .* > max/)
}

function testAcceptsAlignedBook(): void {
  const config = loadConfig()
  config.strategy = 'certainty'
  config.certaintyMinZ = 0
  const ev = evaluateCertainty(basePred(), baseMarket(), 1.13, 1.12, config, Date.now(), {
    clobAsk: 0.92,
    clobOppAsk: 0.08,
    requireClobAsk: true,
  })
  assert.equal(ev.ok, true)
  assert.equal(ev.side, 'up')
  assert.ok(ev.ask >= 0.9)
}

function main(): void {
  testStrikePrefersPriceToBeat()
  testRejectsCheapFavoredAsk()
  testRejectsPhantomEdge()
  testAcceptsAlignedBook()
  console.log('certainty-selftest: ok')
}

main()
