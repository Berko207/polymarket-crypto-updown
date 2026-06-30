import { useEffect, useMemo, useRef, useState } from 'react'
import { placeOrder, type OpenOrder, type Position } from '../lib/api'
import { formatPercent } from '../lib/polymarket'
import {
  coinSymbolFromPosition,
  formatOrderLabel,
  formatPositionLabel,
} from '../lib/marketLabels'
import { livePriceForPosition } from '../lib/positionPnl'
import { bestBidFromQuotes, useLiveTokenQuotes } from '../hooks/useLiveTokenQuotes'
import { OrderConfirmDialog } from './OrderConfirmDialog'
import { PositionPnl } from './PositionPnl'

interface OpenOrdersProps {
  enabled: boolean
  orders: OpenOrder[]
  positions: Position[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  onCancel: (orderId: string) => Promise<void>
  liveQuotesEnabled?: boolean
  liveThrottleMs?: number
  onChanged?: () => void
}

type PanelTab = 'orders' | 'positions'

export function OpenOrders({
  enabled,
  orders,
  positions,
  loading,
  error,
  onRefresh,
  onCancel,
  liveQuotesEnabled = true,
  liveThrottleMs = 0,
  onChanged,
}: OpenOrdersProps) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<PanelTab>('orders')
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [selling, setSelling] = useState<string | null>(null)
  const [confirmSell, setConfirmSell] = useState<{ position: Position; price: number } | null>(null)
  const prevOrderCount = useRef(orders.length)

  const positionTokenIds = useMemo(() => positions.map((p) => p.tokenId), [positions])
  const liveQuotes = useLiveTokenQuotes(positionTokenIds, {
    enabled: enabled && liveQuotesEnabled && positions.length > 0,
    throttleMs: liveThrottleMs,
  })

  useEffect(() => {
    if (orders.length > prevOrderCount.current) setTab('orders')
    prevOrderCount.current = orders.length
  }, [orders.length])

  const handleCancel = async (orderId: string) => {
    setCancelling(orderId)
    try {
      await onCancel(orderId)
      onChanged?.()
    } finally {
      setCancelling(null)
    }
  }

  const submitSell = async () => {
    if (!confirmSell) return
    const { position } = confirmSell
    setConfirmSell(null)
    setSelling(position.tokenId)

    try {
      await placeOrder({
        tokenId: position.tokenId,
        side: 'SELL',
        orderType: 'market',
        size: position.size,
      })
      onRefresh()
      onChanged?.()
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
              className={tab === 'orders' ? 'active' : ''}
              onClick={() => setTab('orders')}
            >
              Orders{orders.length > 0 ? ` (${orders.length})` : ''}
            </button>
            <button
              type="button"
              role="tab"
              className={tab === 'positions' ? 'active' : ''}
              onClick={() => setTab('positions')}
            >
              Positions{positions.length > 0 ? ` (${positions.length})` : ''}
            </button>
          </div>

          {loading && !orders.length && !positions.length && <p className="open-orders-hint">Loading…</p>}
          {error && <p className="open-orders-error">{error}</p>}

          {tab === 'orders' && !loading && orders.length === 0 && (
            <p className="open-orders-hint">No open orders</p>
          )}

          {tab === 'positions' && !loading && positions.length === 0 && (
            <p className="open-orders-hint">No active positions</p>
          )}

          {tab === 'orders' && (
            <ul className="open-orders-list">
              {orders.map((order) => {
                const { asset, window } = formatOrderLabel(order, positions)
                const outcomeClass = order.outcome.toLowerCase()

                return (
                  <li key={order.id} className="open-order-item">
                    <div className="open-order-main">
                      <span className="open-order-title">{asset}</span>
                      {window && <span className="open-order-window">{window}</span>}
                    </div>
                    <div className="open-order-main">
                      <span className={`open-order-side ${outcomeClass}`}>
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
                )
              })}
            </ul>
          )}

          {tab === 'positions' && (
            <ul className="open-orders-list">
              {positions.map((position) => {
                const tokenBid = bestBidFromQuotes(liveQuotes, position.tokenId)
                const price = livePriceForPosition(
                  position,
                  { up: null, down: null },
                  undefined,
                  tokenBid,
                )
                const { asset, window } = formatPositionLabel(position)
                const outcomeClass = position.outcome.toLowerCase()

                return (
                  <li key={position.tokenId} className="open-order-item position-item">
                    <div className="open-order-main">
                      <span className="open-order-title">{asset}</span>
                      {window && <span className="open-order-window">{window}</span>}
                    </div>
                    <div className="open-order-main">
                      <span className={`open-order-side ${outcomeClass}`}>{position.outcome}</span>
                      <span className="open-order-price">{position.size.toFixed(2)} shares</span>
                    </div>
                    <PositionPnl position={position} tokenBid={tokenBid} compact />
                    <div className="open-order-meta">
                      <span>
                        {price != null ? <>Bid {formatPercent(price)}</> : `@ ${formatPercent(position.currentPrice)}`}
                      </span>
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

          <button type="button" className="open-orders-refresh" onClick={onRefresh} disabled={loading}>
            Refresh
          </button>
        </div>
      )}

      {confirmSell && (
        <OrderConfirmDialog
          side="SELL"
          outcome={confirmSell.position.outcome.toLowerCase() === 'down' ? 'down' : 'up'}
          coinSymbol={coinSymbolFromPosition(confirmSell.position)}
          price={confirmSell.price}
          size={confirmSell.position.size}
          onConfirm={() => void submitSell()}
          onCancel={() => setConfirmSell(null)}
        />
      )}
    </div>
  )
}
