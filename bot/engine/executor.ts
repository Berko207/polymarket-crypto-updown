/**
 * Order executor. M2 provides the paper (dry) implementation; the live executor
 * (M4) swaps in placeMarketOrder behind the same interface — so the strategy and
 * loop never change between dry and live.
 */
import type { Order } from './strategy'
import { normalizeLiveFill } from '../tradeFill'

export interface Fill {
  fillPrice: number
  fillSize: number
  orderId: string | null
}

/** Close (all or part) of an open position — the swing scalp's auto-sell. */
export interface SellOrder {
  side: 'up' | 'down'
  tokenId: string
  size: number
  /** Best bid for the side: the paper fill and the live FAK floor hint. */
  sellPrice: number
  tickSize: number | null
  negRisk: boolean | null
}

export interface Executor {
  buy(order: Order): Promise<Fill>
  sell(order: SellOrder): Promise<Fill>
}

/**
 * Paper fills. A market FAK BUY takes the resting ask and a market FAK SELL hits
 * the resting bid, so the paper fill accepts the strategy's book price at face
 * value — buy-at-ask / sell-at-bid means paper P&L pays the real spread. No
 * network, no signing. (Optimistic on thin books — the live executor records the
 * realized fill.)
 */
export const dryExecutor: Executor = {
  buy(order) {
    return Promise.resolve({
      fillPrice: order.fillPrice,
      fillSize: order.stakeUsd / order.fillPrice,
      orderId: null,
    })
  },
  sell(order) {
    return Promise.resolve({
      fillPrice: order.sellPrice,
      fillSize: order.size,
      orderId: null,
    })
  },
}

/**
 * Live executor: places a real market BUY via the app's proven order path
 * (placeMarketOrder — FAK, buffered limit, cost/tick handling). The order path
 * is dynamically imported on first use so record/dry never load viem/clob-client.
 * A no-fill (unmatched/failed) returns fillSize 0 — the caller records nothing.
 */
export function isInsufficientBalanceError(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('not enough balance') || lower.includes('insufficient usdc')
}

/** Outcome token no longer tradeable — usually already redeemed or delisted post-resolution. */
export function isGoneOutcomeTokenError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('invalid token') ||
    lower.includes('token not found') ||
    lower.includes('market not found') ||
    lower.includes('not enough balance / allowance')
  )
}

export function makeLiveExecutor(): Executor {
  let place: typeof import('../../api/_lib/clob').placeMarketOrder | null = null
  let fetchBal: typeof import('../../api/_lib/clob').fetchUsdcBalance | null = null
  const load = async (): Promise<typeof import('../../api/_lib/clob').placeMarketOrder> => {
    if (!place) place = (await import('../../api/_lib/clob')).placeMarketOrder
    return place
  }
  const loadBal = async (): Promise<typeof import('../../api/_lib/clob').fetchUsdcBalance> => {
    if (!fetchBal) fetchBal = (await import('../../api/_lib/clob')).fetchUsdcBalance
    return fetchBal
  }
  // One live buy at a time — parallel entry ticks across coins were racing on the
  // same USDC balance and CLOB was rejecting with "sum of matched orders" errors.
  let buyChain: Promise<unknown> = Promise.resolve()
  return {
    async buy(order) {
      const run = async (): Promise<Fill> => {
        const bal = await (await loadBal())()
        if (order.stakeUsd > bal) {
          throw new Error(
            `insufficient USDC (need $${order.stakeUsd.toFixed(2)}, have $${bal.toFixed(2)})`,
          )
        }
        const res = await (await load())({
          tokenId: order.tokenId,
          side: 'BUY',
          amount: order.stakeUsd,
          price: order.fillPrice,
          orderType: 'market',
          tickSize: order.tickSize ?? undefined,
          negRisk: order.negRisk ?? undefined,
        })
        const status = (res.status ?? '').toLowerCase()
        const matched =
          res.success && status !== 'unmatched' && order.fillPrice > 0 && order.fillPrice < 1
        if (!matched) {
          return { fillPrice: 0, fillSize: 0, orderId: res.orderId ?? null }
        }
        const amounts = normalizeLiveFill(
          order.stakeUsd,
          order.fillPrice,
          res.fillPrice ?? 0,
          res.fillSize ?? 0,
        )
        if (!amounts) {
          return { fillPrice: 0, fillSize: 0, orderId: res.orderId ?? null }
        }
        return {
          fillPrice: amounts.entryPrice,
          fillSize: amounts.size,
          orderId: res.orderId ?? null,
        }
      }
      const p = buyChain.then(run, run)
      buyChain = p.catch(() => {})
      return p
    },
    async sell(order) {
      const res = await (await load())({
        tokenId: order.tokenId,
        side: 'SELL',
        amount: order.size,
        price: order.sellPrice,
        orderType: 'market',
        tickSize: order.tickSize ?? undefined,
        negRisk: order.negRisk ?? undefined,
      })
      const status = (res.status ?? '').toLowerCase()
      if (!res.success || status === 'unmatched' || !res.fillSize || !res.fillPrice) {
        return { fillPrice: 0, fillSize: 0, orderId: res.orderId ?? null }
      }
      return { fillPrice: res.fillPrice, fillSize: res.fillSize, orderId: res.orderId ?? null }
    },
  }
}
