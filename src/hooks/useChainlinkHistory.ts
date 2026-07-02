import { useEffect, useMemo, useRef, useState } from 'react'
import { chainlinkSocket, type ChainlinkTick } from '@/lib/chainlinkSocket'

/**
 * Live tick history for one pair from the shared Chainlink ring buffer,
 * re-rendering at most once per second (RTDS can emit ~5 ticks/s).
 */
export function useChainlinkHistory(pair: string | null, sinceMs: number): ChainlinkTick[] {
  const [version, setVersion] = useState(0)
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!pair) return
    const unsubscribe = chainlinkSocket.subscribe([pair], () => {
      if (throttleRef.current) return
      throttleRef.current = setTimeout(() => {
        throttleRef.current = null
        setVersion((v) => v + 1)
      }, 1_000)
    })
    return () => {
      unsubscribe()
      if (throttleRef.current) {
        clearTimeout(throttleRef.current)
        throttleRef.current = null
      }
    }
  }, [pair])

  return useMemo(
    () => (pair ? chainlinkSocket.ticksSince(pair, sinceMs) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version invalidates the buffer read
    [pair, sinceMs, version],
  )
}
