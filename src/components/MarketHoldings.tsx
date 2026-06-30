import { useCallback, useEffect, useState } from 'react'
import { cancelOrder, fetchOpenOrders, fetchPositions, placeOrder, type OpenOrder, type Position } from '../lib/api'
import { formatPercent } from '../lib/polymarket'
import { livePriceForPosition } from '../lib/positionPnl'
import { OrderConfirmDialog } from './OrderConfirmDialog'
import { PositionPnl } from './PositionPnl'

interface MarketHoldingsProps {
  enabled: boolean
  upTokenId: string | null
  downTokenId: string | null
  bestBidUp: number | null
  bestBidDown: number | null
  upPrice?: number | null
  downPrice?: number | null
  refreshKey?: number
  onChanged?: () => void
}

function sellPrice(
  position: Position,
  bestBidUp: number | null,
  bestBidDown: number | null,
  upPrice?: number | null,
  downPrice?: number | null,
): number | null {
  return livePriceForPosition(
    position,
    { up: bestBidUp, down: bestBidDown },
    { up: upPrice ?? null, down: downPrice ?? null },
  )
}

export function MarketHoldings({
  enabled,
  upTokenId,
  downTokenId,
  bestBidUp,
  bestBidDown,
  upPrice,
  downPrice,
  refreshKey = 0,
  onChanged,
}: MarketHoldingsProps) {
  const [positions, setPositions] = useState<Position[]>([])
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selling, setSelling] = useState<string | null>(null)
  const [confirmSell, setConfirmSell] = useState<{
    position: Position
    price: number
  } | null>(null)
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const load = useCallback(async () => {
    if (!enabled || (!upTokenId && !downTokenId)) {
      setPositions([])
      setOpenOrders([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const tokenIds = new Set([upTokenId, downTokenId].filter(Boolean) as string[])
      const [nextPositions, orders] = await Promise.all([fetchPositions({ upTokenId, downTokenId }), fetchOpenOrders()])
      setPositions(nextPositions)
      setOpenOrders(orders.filter((o) => tokenIds.has(o.assetId)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load holdings')
      setPositions([])
      setOpenOrders([])
    } finally {
      setLoading(false)
    }
  }, [enabled, upTokenId, downTokenId])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => void load(), 15_000)
    return () => clearInterval(id)
  }, [enabled, load])

  const requestSell = (position: Position) => {
    const price = sellPrice(position, bestBidUp, bestBidDown, upPrice, downPrice)
    if (!price) {
      setMessage({ type: 'err', text: 'No bid available to sell into' })
      return
    }
    setMessage(null)
    setConfirmSell({ position, price })
  }

  const submitSell = async () => {
    if (!confirmSell) return
    const { position, price } = confirmSell
    setConfirmSell(null)
    setSelling(position.tokenId)
    setMessage(null)

    try {
      const result = await placeOrder({
        tokenId: position.tokenId,
        side: 'SELL',
        orderType: 'market',
        size: position.size,
      })
      const id = result.orderId ? ` · ${result.orderId.slice(0, 8)}…` : ''
      setMessage({ type: 'ok', text: `Sell ${position.outcome} submitted${id}` })
      await load()
      onChanged?.()
    } catch (e) {
      setMessage({
        type: 'err',
        text: e instanceof Error ? e.message : 'Sell failed',
      })
    } finally {
      setSelling(null)
    }
  }

  if (!enabled) return null

  const hasContent = loading || positions.length > 0 || openOrders.length > 0 || error || message

  if (!hasContent) return null

  return (
    <section className="market-holdings" aria-label="Your position">
      <div className="market-holdings-header">
        <strong>Your position</strong>
        <button type="button" className="market-holdings-refresh" onClick={() => void load()} disabled={loading}>
          {loading ? '…' : '↻'}
        </button>
      </div>

      {error && <p className="market-holdings-error">{error}</p>}
      {message && <p className={`market-holdings-msg ${message.type}`}>{message.text}</p>}

      {positions.length === 0 && openOrders.length === 0 && !loading && !error && (
        <p className="market-holdings-hint">No shares in this market yet.</p>
      )}

      {openOrders.length > 0 && (
        <ul className="market-holdings-list pending-orders">
          {openOrders.map((order) => (
            <li key={order.id} className="market-holding-item pending">
              <div className="market-holding-main">
                <span className="market-holding-outcome pending">Open {order.side}</span>
                <span className="market-holding-size">
                  {order.outcome} · {order.sizeRemaining.toFixed(2)} @ {formatPercent(order.price)}
                </span>
              </div>
              <div className="market-holding-meta">
                <span>Waiting to fill</span>
                <button
                  type="button"
                  className="market-holding-sell cancel"
                  onClick={() => void cancelOrder(order.id).then(() => load()).then(() => onChanged?.())}
                >
                  Cancel
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ul className="market-holdings-list">
        {positions.map((position) => {
          const price = sellPrice(position, bestBidUp, bestBidDown, upPrice, downPrice)
          const outcomeClass = position.outcome.toLowerCase()

          return (
            <li key={position.tokenId} className="market-holding-item">
              <div className="market-holding-main">
                <span className={`market-holding-outcome ${outcomeClass}`}>{position.outcome}</span>
                <span className="market-holding-size">{position.size.toFixed(2)} shares</span>
              </div>
              <PositionPnl
                position={position}
                bestBidUp={bestBidUp}
                bestBidDown={bestBidDown}
                upPrice={upPrice}
                downPrice={downPrice}
              />
              <div className="market-holding-meta">
                <span>
                  {position.avgPrice > 0 && <>Cost ${(position.size * position.avgPrice).toFixed(2)} · </>}
                  {price != null ? <>Bid {formatPercent(price)}</> : 'No bid'}
                </span>
                <button
                  type="button"
                  className={`market-holding-sell ${outcomeClass}`}
                  onClick={() => requestSell(position)}
                  disabled={selling === position.tokenId || price == null || position.redeemable}
                >
                  {selling === position.tokenId ? 'Selling…' : position.redeemable ? 'Resolved' : 'Sell'}
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      {confirmSell && (
        <OrderConfirmDialog
          side="SELL"
          outcome={confirmSell.position.outcome.toLowerCase() === 'down' ? 'down' : 'up'}
          coinSymbol="Position"
          price={confirmSell.price}
          size={confirmSell.position.size}
          onConfirm={() => void submitSell()}
          onCancel={() => setConfirmSell(null)}
        />
      )}
    </section>
  )
}
