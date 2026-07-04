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
 * (Optimistic on thin books — M4 compares paper vs realized fills.)
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
