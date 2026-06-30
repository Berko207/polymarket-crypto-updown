import { useState } from 'react'
import type { OpenOrder, Position } from '../lib/api'
import { formatOrderLabel } from '../lib/marketLabels'
import { formatPercent } from '../lib/polymarket'

interface OpenOrdersBarProps {
  orders: OpenOrder[]
  positions: Position[]
  cancellingId: string | null
  onCancel: (orderId: string) => void
}

export function OpenOrdersBar({ orders, positions, cancellingId, onCancel }: OpenOrdersBarProps) {
  const [collapsed, setCollapsed] = useState(false)

  if (!orders.length) return null

  return (
    <section className="open-orders-bar" aria-label="Open orders across markets">
      <div className="open-orders-bar-header">
        <button
          type="button"
          className="open-orders-bar-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
        >
          <span className="open-orders-bar-title">
            Open orders <span className="open-orders-bar-count">{orders.length}</span>
          </span>
          <span className="open-orders-bar-chevron" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
        </button>
        <span className="open-orders-bar-hint">Updates live · all markets</span>
      </div>

      {!collapsed && (
        <ul className="open-orders-bar-list">
          {orders.map((order) => {
            const { asset, window } = formatOrderLabel(order, positions)
            const outcomeClass = order.outcome.toLowerCase()

            return (
              <li key={order.id} className="open-orders-bar-item">
                <div className="open-orders-bar-main">
                  <span className="open-orders-bar-asset">{asset}</span>
                  {window && <span className="open-orders-bar-window">{window}</span>}
                  <span className={`open-orders-bar-side ${outcomeClass}`}>
                    {order.side} {order.outcome}
                  </span>
                  <span className="open-orders-bar-price">
                    {order.sizeRemaining.toFixed(2)} @ {formatPercent(order.price)}
                  </span>
                </div>
                <button
                  type="button"
                  className="open-orders-bar-cancel"
                  onClick={() => onCancel(order.id)}
                  disabled={cancellingId === order.id}
                >
                  {cancellingId === order.id ? '…' : 'Cancel'}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
