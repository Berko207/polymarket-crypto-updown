import { useEffect } from 'react'
import { chainlinkSocket } from '@/lib/chainlinkSocket'
import { CHAINLINK_PAIR } from '@/lib/cryptoPrice'

/** Keep Chainlink history warm app-wide — not gated on CLOB update mode. */
export function useChainlinkWarmup() {
  useEffect(() => {
    const pairs = Object.values(CHAINLINK_PAIR).filter(Boolean) as string[]
    if (pairs.length === 0) return
    return chainlinkSocket.subscribe(pairs, () => {})
  }, [])
}
