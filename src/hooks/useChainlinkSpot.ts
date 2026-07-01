import { useEffect, useState } from 'react'
import { chainlinkSocket, type ChainlinkTick } from '@/lib/chainlinkSocket'
import { chainlinkPair } from '@/lib/cryptoPrice'
import type { CoinId } from '@/lib/types'

/** Coin-level Chainlink spot — always on for supported coins (independent of CLOB throttle mode). */
export function useChainlinkSpot(coin: CoinId) {
  const pair = chainlinkPair(coin)
  const enabled = Boolean(pair)

  const [tick, setTick] = useState<ChainlinkTick | null>(() =>
    pair ? chainlinkSocket.latestTick(pair) : null,
  )
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!enabled || !pair) {
      setConnected(false)
      return
    }

    return chainlinkSocket.subscribe(
      [pair],
      (prices) => setTick(prices[pair] ?? chainlinkSocket.latestTick(pair)),
      setConnected,
    )
  }, [coin, enabled, pair])

  return { tick, connected, enabled, pair }
}
