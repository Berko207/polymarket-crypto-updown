/**
 * Dry maker executor — the honest resting-limit fill SIMULATOR that is the whole
 * point of the maker paper-strategy (docs/maker-paper-strategy.md §2, §7).
 *
 * A resting BUY at price p does NOT fill when the mid merely touches p (that's the
 * banned "L0" optimistic model that flatters maker P&L). It fills only when a real
 * trade prints THROUGH it — a sale at price ≤ p, after the order was posted — and
 * the fill price is ALWAYS our own quoted price, because we were the passive side.
 *
 * Fidelity levels (config.makerFillModel):
 *  - L1: trade-through, ignoring queue position. Honest on fill PRICE, optimistic
 *        on fill RATE (assumes we're at the front of the queue).
 *  - L2: additionally consume `qAhead` (size resting ahead of us at our level when
 *        we posted) before we fill — queue priority, the thing rebate-farming lives
 *        or dies on. Seed `qAhead` from live book depth at post time (Phase 2).
 *
 * This class is pure (no I/O): the loop feeds it trade prints via `step` and it
 * returns the fills to book. The live executor (Phase 5) implements the same
 * post/cancel surface with real GTC post-only orders.
 */
import type { TradePrint } from '../sources/clobMarket'
import { makerRebate } from './makerFees'

/** A quote we want resting on the book. `side` is the token this order BUYs. */
export interface MakerQuote {
  windowKey: string
  side: 'up' | 'down'
  tokenId: string
  price: number
  /** Shares. */
  size: number
}

export interface RestingOrder extends MakerQuote {
  id: string
  postedT: number
  /** L2 queue-ahead remaining (shares); 0 under L1. */
  qAhead: number
  /** Cumulative shares filled. */
  filled: number
}

export interface MakerFill {
  orderId: string
  windowKey: string
  side: 'up' | 'down'
  tokenId: string
  /** Always the resting order's quoted price. */
  price: number
  /** Shares filled by this event (orders can fill in several partials). */
  size: number
  rebate: number
  t: number
}

export interface MakerSimOptions {
  fillModel: 'L1' | 'L2'
  rebateRate: number
}

const EPS = 1e-9

export class MakerSimExecutor {
  private resting = new Map<string, RestingOrder>()
  private seq = 0
  constructor(private opts: MakerSimOptions) {}

  /** Update fill model / rebate at runtime (the loop reads config; the sim caches these). */
  setOptions(opts: Partial<MakerSimOptions>): void {
    this.opts = { ...this.opts, ...opts }
  }

  /** Post a resting quote. `qAhead` is only honored under L2. */
  post(q: MakerQuote, now: number, qAhead = 0): RestingOrder {
    const id = `m${++this.seq}`
    const order: RestingOrder = {
      ...q,
      id,
      postedT: now,
      qAhead: this.opts.fillModel === 'L2' ? Math.max(0, qAhead) : 0,
      filled: 0,
    }
    this.resting.set(id, order)
    return order
  }

  cancel(id: string): void {
    this.resting.delete(id)
  }

  cancelWindow(windowKey: string): void {
    for (const [id, o] of this.resting) if (o.windowKey === windowKey) this.resting.delete(id)
  }

  cancelAll(): void {
    this.resting.clear()
  }

  open(windowKey?: string): RestingOrder[] {
    const all = [...this.resting.values()]
    return windowKey == null ? all : all.filter((o) => o.windowKey === windowKey)
  }

  /**
   * Advance every resting order against new trade prints (keyed by tokenId, each
   * list ascending by ts and containing only prints since the last step). Returns
   * the fills produced. See the class comment for the fill rule.
   */
  step(tradesByToken: Map<string, TradePrint[]>): MakerFill[] {
    const fills: MakerFill[] = []
    for (const o of this.resting.values()) {
      const prints = tradesByToken.get(o.tokenId)
      if (!prints?.length) continue
      for (const p of prints) {
        if (p.ts < o.postedT) continue // can't fill on a trade that predates the order
        // Trade-through: a sale at/below our bid. A known taker BUY lifts asks, not
        // bids, so it can't fill us; unknown-side prints fall back to the price test.
        if (p.side === 'buy' || !(p.price <= o.price + EPS)) continue
        let avail = p.size != null && p.size > 0 ? p.size : Number.POSITIVE_INFINITY
        if (o.qAhead > EPS) {
          const consumed = Math.min(o.qAhead, avail)
          o.qAhead -= consumed
          avail -= consumed
        }
        const remaining = o.size - o.filled
        const qty = Math.min(remaining, avail)
        if (qty <= EPS) continue
        o.filled += qty
        fills.push({
          orderId: o.id,
          windowKey: o.windowKey,
          side: o.side,
          tokenId: o.tokenId,
          price: o.price,
          size: qty,
          rebate: makerRebate(o.price, qty, this.opts.rebateRate),
          t: p.ts,
        })
        if (o.filled >= o.size - EPS) break
      }
      if (o.filled >= o.size - EPS) this.resting.delete(o.id)
    }
    return fills
  }
}
