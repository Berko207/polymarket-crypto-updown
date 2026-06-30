import { useCallback, useEffect, useState } from 'react'
import {
  cancelOrder,
  fetchOpenOrders,
  fetchPositions,
  type OpenOrder,
  type Position,
} from '../lib/api'

const POLL_MS = 3_000

function isCryptoUpDown(title: string): boolean {
  return title.toLowerCase().includes('up or down')
}

function filterPositions(rows: Position[]): Position[] {
  return rows.filter(
    (p) => isCryptoUpDown(p.title) && p.size > 0 && !p.redeemable && p.currentPrice > 0,
  )
}

export function usePortfolio(enabled: boolean, refreshKey = 0) {
  const [orders, setOrders] = useState<OpenOrder[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(
    async (silent = false) => {
      if (!enabled) {
        setOrders([])
        setPositions([])
        setError(null)
        return
      }

      if (!silent) setLoading(true)
      setError(null)

      try {
        const [nextOrders, nextPositions] = await Promise.all([fetchOpenOrders(), fetchPositions()])
        setOrders(nextOrders)
        setPositions(filterPositions(nextPositions))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load portfolio')
      } finally {
        setLoading(false)
      }
    },
    [enabled],
  )

  useEffect(() => {
    void refresh(false)
  }, [enabled, refreshKey, refresh])

  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => void refresh(true), POLL_MS)
    return () => clearInterval(id)
  }, [enabled, refresh])

  const cancel = useCallback(
    async (orderId: string) => {
      await cancelOrder(orderId)
      await refresh(true)
    },
    [refresh],
  )

  return {
    orders,
    positions,
    loading,
    error,
    refresh: () => void refresh(false),
    cancel,
  }
}
