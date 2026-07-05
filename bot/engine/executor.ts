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
export function makeLiveExecutor(): Executor {
  let place: typeof import('../../api/_lib/clob').placeMarketOrder | null = null
  const load = async (): Promise<typeof import('../../api/_lib/clob').placeMarketOrder> => {
    if (!place) place = (await import('../../api/_lib/clob')).placeMarketOrder
    return place
  }
  return {
    async buy(order) {
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
      if (!res.success || status === 'unmatched' || !res.fillSize || !res.fillPrice) {
        return { fillPrice: 0, fillSize: 0, orderId: res.orderId ?? null }
      }
      return { fillPrice: res.fillPrice, fillSize: res.fillSize, orderId: res.orderId ?? null }
    },
    async sell(order) {
      const res = await (await load())({
        tokenId: order.tokenId,
        side: 'SELL',
        size: order.size,
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
