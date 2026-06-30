import { useEffect, useMemo, useRef, useState } from 'react'
import { clobSocket, type TokenQuoteMap } from '@/lib/clobSocket'

export interface UseTokenQuotesOptions {
  enabled: boolean
  /** Min ms between UI updates (0 = every frame). */
  throttleMs: number
}

export interface TokenQuotesState {
  quotes: TokenQuoteMap
  connected: boolean
}

const EMPTY: TokenQuoteMap = {}

/**
 * Subscribe a set of outcome tokens to the shared {@link clobSocket} and return
 * their live quotes, with trailing-edge throttling so high-frequency books don't
 * thrash React. One socket is shared across every caller in the app.
 */
export function useTokenQuotes(
  tokenIds: string[],
  { enabled, throttleMs }: UseTokenQuotesOptions,
): TokenQuotesState {
  const [quotes, setQuotes] = useState<TokenQuoteMap>(EMPTY)
  const [connected, setConnected] = useState(false)
  const pendingRef = useRef<TokenQuoteMap | null>(null)
  const lastEmitRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const idsKey = useMemo(
    () => [...new Set(tokenIds.filter(Boolean))].sort().join(','),
    [tokenIds],
  )

  useEffect(() => {
    setQuotes(EMPTY)
    setConnected(false)
    pendingRef.current = null
    lastEmitRef.current = 0
    if (timerRef.current) clearTimeout(timerRef.current)

    const ids = idsKey ? idsKey.split(',') : []
    if (!enabled || ids.length === 0) return

    const emit = (next: TokenQuoteMap) => {
      lastEmitRef.current = Date.now()
      pendingRef.current = null
      setQuotes(next)
    }

    const scheduleEmit = (next: TokenQuoteMap) => {
      if (throttleMs <= 0) {
        emit(next)
        return
      }
      pendingRef.current = next
      const elapsed = Date.now() - lastEmitRef.current
      if (elapsed >= throttleMs) {
        emit(next)
        return
      }
      if (timerRef.current) return
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        if (pendingRef.current) emit(pendingRef.current)
      }, throttleMs - elapsed)
    }

    const unsubscribe = clobSocket.subscribe(ids, scheduleEmit, setConnected)
    return () => {
      unsubscribe()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [idsKey, enabled, throttleMs])

  return { quotes, connected }
}
