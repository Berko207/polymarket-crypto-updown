/**
 * Maker quoting math (pure) for the maker paper-strategy
 * (docs/maker-paper-strategy.md §5). Given the fair-value model, the live books,
 * and current inventory, produce the two passive quotes we want resting:
 *
 *   bid  — BUY Up   @ r − δ        (accumulate YES)
 *   ask  — BUY Down @ 1 − (r + δ)  (shed YES ≡ accumulate NO)
 *
 * where r = FV − inventory-skew and δ = base + vol + toxicity half-spread. When
 * both fill evenly we're ~flat and have banked ≈2δ minus fees plus any rebate.
 *
 * The differentiator vs. microprice-only MM bots: FV is anchored on our Φ(d₂)
 * model (predict.ts), optionally blended with the book microprice.
 */
import type { BotConfig } from '../config'
import type { Prediction } from './predict'
import { sourceProb } from './swing'
import type { TokenBook } from '../sources/clobMarket'
import type { MakerQuote } from './makerExecutor'

const EPS = 1e-9

/** Net YES inventory (shares). Positive = long Up, negative = long Down. */
export interface MakerInventory {
  upShares: number
  downShares: number
}

export function netYes(inv: MakerInventory): number {
  return inv.upShares - inv.downShares
}

/** Size-weighted microprice from a token book; falls back to mid, then a lone side. */
export function microprice(book: TokenBook | null): number | null {
  if (!book) return null
  const { bestBid: bid, bestAsk: ask } = book
  if (bid == null || ask == null) return bid ?? ask ?? null
  const bidSz = book.bids[0]?.size ?? 0
  const askSz = book.asks[0]?.size ?? 0
  if (bidSz + askSz <= 0) return (bid + ask) / 2
  // Weight each side by the OPPOSITE size: heavy asks push the microprice toward the bid.
  return (bid * askSz + ask * bidSz) / (bidSz + askSz)
}

/** Model fair value, optionally blended with the microprice (weight 0 = pure model). */
export function fairValue(pred: Prediction, upBook: TokenBook | null, config: BotConfig): number {
  const model = sourceProb(pred, config.signalSource)
  const w = config.makerMicropriceWeight
  if (w <= 0) return model
  const mp = microprice(upBook)
  if (mp == null) return model
  return (1 - w) * model + w * mp
}

export function halfSpread(config: BotConfig, sigmaWindow: number, toxicity: number): number {
  return config.makerBaseSpread + config.makerVolCoef * sigmaWindow + config.makerToxCoef * toxicity
}

const clampFactor = (x: number): number => Math.min(1, Math.max(0, x))
function roundToTick(price: number, tick: number): number {
  return Math.round(price / tick) * tick
}
const clampPrice = (p: number, tick: number): number => Math.min(1 - tick, Math.max(tick, p))

export interface MakerContext {
  pred: Prediction
  upBook: TokenBook | null
  downBook: TokenBook | null
  upTokenId: string | null
  downTokenId: string | null
  tickSize: number | null
  msRemaining: number
}

/**
 * The two-sided quote we want resting for this window right now, or fewer/none when
 * a side is capped by inventory, would cross the book (not passive), or the window
 * is inside the boundary pull. Prices are tick-aligned and in (tick, 1−tick).
 */
export function decideQuotes(
  ctx: MakerContext,
  inv: MakerInventory,
  config: BotConfig,
  toxicity = 0,
): MakerQuote[] {
  const { pred, msRemaining } = ctx
  if (msRemaining <= config.makerPullSec * 1_000) return [] // pulled near the boundary
  if (pred.confidence !== 'ok') return []
  if (pred.regime === 'panic') return []

  const tick = ctx.tickSize && ctx.tickSize > 0 ? ctx.tickSize : 0.01
  const fv = fairValue(pred, ctx.upBook, config)
  const q = netYes(inv)
  const qMax = config.makerMaxInventory
  const r = fv - config.makerInvSkew * (qMax > 0 ? q / qMax : 0)

  let delta = halfSpread(config, pred.sigmaWindow, toxicity)
  if (msRemaining <= config.makerWidenSec * 1_000) {
    // Widen up to +base as the window approaches the pull point.
    const frac = clampFactor(1 - msRemaining / (config.makerWidenSec * 1_000))
    delta += config.makerBaseSpread * frac
  }

  const quotes: MakerQuote[] = []
  const clip = config.makerClipUsd

  // Bid: BUY Up @ r − δ  (adds YES; capped by room to go long).
  if (ctx.upTokenId) {
    const room = qMax > 0 ? clampFactor((qMax - q) / qMax) : 1
    const price = clampPrice(roundToTick(r - delta, tick), tick)
    const passive = ctx.upBook?.bestAsk == null || price < ctx.upBook.bestAsk - EPS
    if (room > 0 && passive) {
      const size = (clip / price) * room
      if (size > EPS) quotes.push({ windowKey: pred.windowKey, side: 'up', tokenId: ctx.upTokenId, price, size })
    }
  }
  // Ask: BUY Down @ 1 − (r + δ)  (adds NO ≡ sheds YES; capped by room to go short).
  if (ctx.downTokenId) {
    const room = qMax > 0 ? clampFactor((qMax + q) / qMax) : 1
    const price = clampPrice(roundToTick(1 - (r + delta), tick), tick)
    const passive = ctx.downBook?.bestAsk == null || price < ctx.downBook.bestAsk - EPS
    if (room > 0 && passive) {
      const size = (clip / price) * room
      if (size > EPS) quotes.push({ windowKey: pred.windowKey, side: 'down', tokenId: ctx.downTokenId, price, size })
    }
  }
  return quotes
}
