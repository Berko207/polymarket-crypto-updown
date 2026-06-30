import { useEffect, useMemo, useRef, useState } from 'react'
import { quoteToPrice, subscribeTokenQuotes, type TokenQuoteMap } from '../lib/clobWs'

export interface LiveTokenQuotesOptions {
  enabled: boolean
  throttleMs: number
}

const EMPTY: TokenQuoteMap = {}

export function useLiveTokenQuotes(
  tokenIds: string[],
  { enabled, throttleMs }: LiveTokenQuotesOptions,
): TokenQuoteMap {
  const [quotes, setQuotes] = useState<TokenQuoteMap>(EMPTY)
  const pendingRef = useRef<TokenQuoteMap | null>(null)
  const lastEmitRef = useRef(0)
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const idsKey = useMemo(
    () => [...new Set(tokenIds.filter(Boolean))].sort().join(','),
    [tokenIds],
  )

  useEffect(() => {
    setQuotes(EMPTY)
    pendingRef.current = null
    lastEmitRef.current = 0
    if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current)

    const ids = idsKey ? idsKey.split(',') : []
    if (!enabled || !ids.length) return

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

      if (throttleTimerRef.current) return
      throttleTimerRef.current = setTimeout(() => {
        throttleTimerRef.current = null
        if (pendingRef.current) emit(pendingRef.current)
      }, throttleMs - elapsed)
    }

    return subscribeTokenQuotes({
      tokenIds: ids,
      onUpdate: scheduleEmit,
    })
  }, [idsKey, enabled, throttleMs])

  return quotes
}

export function bestBidFromQuotes(quotes: TokenQuoteMap, tokenId: string): number | null {
  const quote = quotes[tokenId]
  if (!quote) return null
  return quote.bestBid
}

export function midFromQuotes(quotes: TokenQuoteMap, tokenId: string): number | null {
  const quote = quotes[tokenId]
  if (!quote) return null
  return quoteToPrice(quote)
}
