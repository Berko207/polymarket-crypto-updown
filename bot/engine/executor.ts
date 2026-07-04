/**
 * Order executor. M2 provides the paper (dry) implementation; the live executor
 * (M4) swaps in placeMarketOrder behind the same interface — so the strategy and
 * loop never change between dry and live.
 */
import type { Order } from './strategy'

export interface Fill {
  fillPrice: number
  fillSize: number
  orderId: string | null
}

export interface Executor {
  buy(order: Order): Promise<Fill>
}

/**
 * Paper fill: a market FAK takes the resting ask in a normal book, so the paper
 * fill accepts the strategy's book price at face value. No network, no signing.
 * (Optimistic on thin books — the live executor records the realized fill.)
 */
export const dryExecutor: Executor = {
  buy(order) {
    return Promise.resolve({
      fillPrice: order.fillPrice,
      fillSize: order.stakeUsd / order.fillPrice,
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
export function makeLiveExecutor(): Executor {
  let place: typeof import('../../api/_lib/clob').placeMarketOrder | null = null
  return {
    async buy(order) {
      if (!place) place = (await import('../../api/_lib/clob')).placeMarketOrder
      const res = await place({
        tokenId: order.tokenId,
        side: 'BUY',
        amount: order.stakeUsd,
        price: order.fillPrice,
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
