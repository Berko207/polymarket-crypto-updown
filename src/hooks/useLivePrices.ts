import { useEffect, useRef, useState } from 'react'
import { subscribeMarketStream, type LiveQuoteUpdate } from '../lib/clobWs'

export interface LivePriceState extends LiveQuoteUpdate {
  connected: boolean
  updatedAt: number | null
}

export interface LivePriceOptions {
  enabled: boolean
  throttleMs: number
}

const EMPTY: LivePriceState = {
  upPrice: null,
  downPrice: null,
  bestBidUp: null,
  bestAskUp: null,
  bestBidDown: null,
  bestAskDown: null,
  connected: false,
  updatedAt: null,
}

export function useLivePrices(
  upTokenId: string | null,
  downTokenId: string | null,
  { enabled, throttleMs }: LivePriceOptions,
): LivePriceState {
  const [state, setState] = useState<LivePriceState>(EMPTY)
  const pendingRef = useRef<LiveQuoteUpdate | null>(null)
  const lastEmitRef = useRef(0)
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setState(EMPTY)
    pendingRef.current = null
    lastEmitRef.current = 0
    if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current)

    if (!enabled || !upTokenId || !downTokenId) return

    const emit = (update: LiveQuoteUpdate) => {
      lastEmitRef.current = Date.now()
      pendingRef.current = null
      setState((prev) => ({
        ...prev,
        ...update,
        updatedAt: Date.now(),
      }))
    }

    const scheduleEmit = (update: LiveQuoteUpdate) => {
      if (throttleMs <= 0) {
        emit(update)
        return
      }

      pendingRef.current = update
      const elapsed = Date.now() - lastEmitRef.current
      if (elapsed >= throttleMs) {
        emit(update)
        return
      }

      if (throttleTimerRef.current) return
      throttleTimerRef.current = setTimeout(() => {
        throttleTimerRef.current = null
        if (pendingRef.current) emit(pendingRef.current)
      }, throttleMs - elapsed)
    }

    return subscribeMarketStream({
      upTokenId,
      downTokenId,
      onConnectedChange: (connected) => {
        setState((prev) => ({ ...prev, connected }))
      },
      onUpdate: scheduleEmit,
    })
  }, [upTokenId, downTokenId, enabled, throttleMs])

  return state
}
