import { useCallback, useEffect, useState } from 'react'
import {
  cancelOrder,
  fetchOpenOrders,
  fetchPositions,
  placeOrder,
  type OpenOrder,
  type Position,
} from '../lib/api'
import { formatPercent } from '../lib/polymarket'
import { livePriceForPosition } from '../lib/positionPnl'
import { OrderConfirmDialog } from './OrderConfirmDialog'
import { PositionPnl } from './PositionPnl'

interface OpenOrdersProps {
  enabled: boolean
  refreshKey?: number
  onChanged?: () => void
}

type PanelTab = 'orders' | 'positions'

function isCryptoUpDown(title: string): boolean {
  return title.toLowerCase().includes('up or down')
}

export function OpenOrders({ enabled, refreshKey = 0, onChanged }: OpenOrdersProps) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<PanelTab>('positions')
  const [orders, setOrders] = useState<OpenOrder[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [selling, setSelling] = useState<string | null>(null)
  const [confirmSell, setConfirmSell] = useState<{ position: Position; price: number } | null>(null)

  const load = useCallback(async () => {
    if (!enabled) {
      setOrders([])
      setPositions([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [nextOrders, nextPositions] = await Promise.all([fetchOpenOrders(), fetchPositions()])
      setOrders(nextOrders)
      setPositions(
        nextPositions.filter(
          (p) => isCryptoUpDown(p.title) && p.size > 0 && !p.redeemable && p.currentPrice > 0,
        ),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load portfolio')
      setOrders([])
      setPositions([])
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    void load()
  }, [enabled, load, refreshKey])

  useEffect(() => {
    if (!enabled || !open) return
    const id = setInterval(() => void load(), 5_000)
    return () => clearInterval(id)
  }, [enabled, open, load])

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

  const submitSell = async () => {
    if (!confirmSell) return
    const { position, price } = confirmSell
    setConfirmSell(null)
    setSelling(position.tokenId)
    setError(null)

    try {
      await placeOrder({
        tokenId: position.tokenId,
        side: 'SELL',
        orderType: 'market',
        size: position.size,
      })
      await load()
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sell failed')
    } finally {
      setSelling(null)
    }
  }

  if (!enabled) return null

  const count = orders.length + positions.length

  return (
    <div className="open-orders">
      <button
        type="button"
        className="open-orders-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        Portfolio{count > 0 ? ` (${count})` : ''}
      </button>

      {open && (
        <div className="open-orders-panel" role="dialog" aria-label="Portfolio">
          <div className="open-orders-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={tab === 'positions' ? 'active' : ''}
              onClick={() => setTab('positions')}
            >
              Positions{positions.length > 0 ? ` (${positions.length})` : ''}
            </button>
            <button
              type="button"
              role="tab"
              className={tab === 'orders' ? 'active' : ''}
              onClick={() => setTab('orders')}
            >
              Orders{orders.length > 0 ? ` (${orders.length})` : ''}
            </button>
          </div>

          {loading && <p className="open-orders-hint">Loading…</p>}
          {error && <p className="open-orders-error">{error}</p>}

          {tab === 'orders' && !loading && orders.length === 0 && (
            <p className="open-orders-hint">No open orders</p>
          )}

          {tab === 'positions' && !loading && positions.length === 0 && (
            <p className="open-orders-hint">No active positions</p>
          )}

          {tab === 'orders' && (
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
          )}

          {tab === 'positions' && (
            <ul className="open-orders-list">
              {positions.map((position) => {
                const price = livePriceForPosition(position, { up: null, down: null })
                const outcomeClass = position.outcome.toLowerCase()

                return (
                  <li key={position.tokenId} className="open-order-item position-item">
                    <div className="open-order-main">
                      <span className="open-order-title">{position.title}</span>
                    </div>
                    <div className="open-order-main">
                      <span className={`open-order-side ${outcomeClass}`}>{position.outcome}</span>
                      <span className="open-order-price">{position.size.toFixed(2)} shares</span>
                    </div>
                    <PositionPnl position={position} bestBidUp={null} bestBidDown={null} compact />
                    <div className="open-order-meta">
                      <span>@ {formatPercent(position.currentPrice)}</span>
                      <button
                        type="button"
                        className={`open-order-sell ${outcomeClass}`}
                        onClick={() => price && setConfirmSell({ position, price })}
                        disabled={selling === position.tokenId || price == null}
                      >
                        {selling === position.tokenId ? '…' : 'Sell'}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          <button type="button" className="open-orders-refresh" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        </div>
      )}

      {confirmSell && (
        <OrderConfirmDialog
          side="SELL"
          outcome={confirmSell.position.outcome.toLowerCase() === 'down' ? 'down' : 'up'}
          coinSymbol={confirmSell.position.title.split(' - ')[0] ?? 'Market'}
          price={confirmSell.price}
          size={confirmSell.position.size}
          onConfirm={() => void submitSell()}
          onCancel={() => setConfirmSell(null)}
        />
      )}
    </div>
  )
}
