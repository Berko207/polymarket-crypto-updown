import { useCallback, useEffect, useState } from 'react'
import { cancelOrder, fetchOpenOrders, type OpenOrder } from '../lib/api'
import { formatPercent } from '../lib/polymarket'

interface OpenOrdersProps {
  enabled: boolean
  refreshKey?: number
  onChanged?: () => void
}

export function OpenOrders({ enabled, refreshKey = 0, onChanged }: OpenOrdersProps) {
  const [open, setOpen] = useState(false)
  const [orders, setOrders] = useState<OpenOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!enabled) {
      setOrders([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const next = await fetchOpenOrders()
      setOrders(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load orders')
      setOrders([])
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    void load()
  }, [enabled, load, refreshKey])

  const handleCancel = async (orderId: string) => {
    setCancelling(orderId)
    setError(null)
    try {
      await cancelOrder(orderId)
      await load()
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cancel failed')
    } finally {
      setCancelling(null)
    }
  }

  if (!enabled) return null

  const count = orders.length

  return (
    <div className="open-orders">
      <button
        type="button"
        className="open-orders-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        Orders{count > 0 ? ` (${count})` : ''}
      </button>

      {open && (
        <div className="open-orders-panel" role="dialog" aria-label="Open orders">
          {loading && <p className="open-orders-hint">Loading…</p>}
          {error && <p className="open-orders-error">{error}</p>}

          {!loading && orders.length === 0 && (
            <p className="open-orders-hint">No open orders</p>
          )}

          <ul className="open-orders-list">
            {orders.map((order) => (
              <li key={order.id} className="open-order-item">
                <div className="open-order-main">
                  <span className={`open-order-side ${order.outcome.toLowerCase()}`}>
                    {order.side} {order.outcome}
                  </span>
                  <span className="open-order-price">{formatPercent(order.price)}</span>
                </div>
                <div className="open-order-meta">
                  <span>
                    {order.sizeRemaining.toFixed(1)} / {order.originalSize.toFixed(1)} left
                  </span>
                  <button
                    type="button"
                    className="open-order-cancel"
                    onClick={() => void handleCancel(order.id)}
                    disabled={cancelling === order.id}
                  >
                    {cancelling === order.id ? '…' : 'Cancel'}
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <button type="button" className="open-orders-refresh" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        </div>
      )}
    </div>
  )
}
