import { formatPercent } from '../lib/polymarket'

interface OrderConfirmDialogProps {
  side?: 'BUY' | 'SELL'
  outcome: 'up' | 'down'
  coinSymbol: string
  price: number
  size: number
  estCost?: number
  usdcBalance?: number
  onConfirm: () => void
  onCancel: () => void
}

export function OrderConfirmDialog({
  side = 'BUY',
  outcome,
  coinSymbol,
  price,
  size,
  estCost,
  usdcBalance,
  onConfirm,
  onCancel,
}: OrderConfirmDialogProps) {
  const estProceeds = estCost ?? price * size
  const insufficient = side === 'BUY' && usdcBalance != null && estProceeds > usdcBalance
  const selling = side === 'SELL'
  const marketBuy = side === 'BUY'

  return (
    <div className="modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className="modal-card"
        role="dialog"
        aria-labelledby="confirm-order-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="confirm-order-title">{selling ? 'Confirm sell' : 'Confirm order'}</h3>
        <dl className="confirm-order-stats">
          <div>
            <dt>Market</dt>
            <dd>{coinSymbol} · {outcome === 'up' ? 'Up' : 'Down'}</dd>
          </div>
          <div>
            <dt>Side</dt>
            <dd>{selling ? 'Sell market' : marketBuy ? 'Buy market' : 'Buy limit'}</dd>
          </div>
          {!marketBuy && (
            <div>
              <dt>Price</dt>
              <dd>{formatPercent(price)}</dd>
            </div>
          )}
          {marketBuy && (
            <div>
              <dt>Est. price</dt>
              <dd>{formatPercent(price)}</dd>
            </div>
          )}
          <div>
            <dt>Shares</dt>
            <dd>{size < 10 ? size.toFixed(2) : size.toFixed(1)}</dd>
          </div>
          <div>
            <dt>{selling ? 'Est. proceeds' : 'Est. cost'}</dt>
            <dd className={insufficient ? 'warn' : ''}>${estProceeds.toFixed(2)}</dd>
          </div>
          {!selling && usdcBalance != null && (
            <div>
              <dt>USDC balance</dt>
              <dd>${usdcBalance.toFixed(2)}</dd>
            </div>
          )}
        </dl>

        {insufficient && (
          <p className="confirm-order-warn">Insufficient USDC for this order.</p>
        )}

        <div className="modal-actions">
          <button type="button" className="modal-btn secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`modal-btn primary ${outcome}`}
            onClick={onConfirm}
            disabled={insufficient}
          >
            {selling ? 'Sell' : 'Place order'}
          </button>
        </div>
      </div>
    </div>
  )
}
