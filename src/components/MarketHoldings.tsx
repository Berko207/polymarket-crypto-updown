import { useMemo, useState } from 'react'
import { placeOrder, type OpenOrder, type Position } from '../lib/api'
import { formatPercent } from '../lib/polymarket'
import { livePriceForPosition } from '../lib/positionPnl'
import { OrderConfirmDialog } from './OrderConfirmDialog'
import { PositionPnl } from './PositionPnl'

interface MarketHoldingsProps {
  enabled: boolean
  marketSubtitle?: string
  coinSymbol?: string
  upTokenId: string | null
  downTokenId: string | null
  bestBidUp: number | null
  bestBidDown: number | null
  upPrice?: number | null
  downPrice?: number | null
  orders: OpenOrder[]
  positions: Position[]
  loading?: boolean
  onCancelOrder: (orderId: string) => Promise<void>
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
  marketSubtitle,
  coinSymbol,
  upTokenId,
  downTokenId,
  bestBidUp,
  bestBidDown,
  upPrice,
  downPrice,
  orders,
  positions,
  loading = false,
  onCancelOrder,
  onChanged,
}: MarketHoldingsProps) {
  const [selling, setSelling] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [confirmSell, setConfirmSell] = useState<{
    position: Position
    price: number
  } | null>(null)
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const tokenIds = useMemo(
    () => new Set([upTokenId, downTokenId].filter(Boolean) as string[]),
    [upTokenId, downTokenId],
  )

  const marketOrders = useMemo(
    () => orders.filter((o) => tokenIds.has(o.assetId)),
    [orders, tokenIds],
  )

  const marketPositions = useMemo(
    () => positions.filter((p) => tokenIds.has(p.tokenId)),
    [positions, tokenIds],
  )

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
    const { position } = confirmSell
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

  const handleCancel = async (orderId: string) => {
    setCancelling(orderId)
    try {
      await onCancelOrder(orderId)
      onChanged?.()
    } catch (e) {
      setMessage({
        type: 'err',
        text: e instanceof Error ? e.message : 'Cancel failed',
      })
    } finally {
      setCancelling(null)
    }
  }

  if (!enabled) return null

  const hasContent =
    loading || marketPositions.length > 0 || marketOrders.length > 0 || message

  if (!hasContent) return null

  return (
    <section className="market-holdings" aria-label="Your position">
      <div className="market-holdings-header">
        <div>
          <strong>Your position</strong>
          {marketSubtitle && <p className="market-holdings-context">{marketSubtitle}</p>}
        </div>
      </div>

      {message && <p className={`market-holdings-msg ${message.type}`}>{message.text}</p>}

      {marketPositions.length === 0 && marketOrders.length === 0 && !loading && (
        <p className="market-holdings-hint">No shares in this market yet.</p>
      )}

      {marketOrders.length > 0 && (
        <ul className="market-holdings-list pending-orders">
          {marketOrders.map((order) => (
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

      <ul className="market-holdings-list">
        {marketPositions.map((position) => {
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
          coinSymbol={coinSymbol ?? 'Market'}
          price={confirmSell.price}
          size={confirmSell.position.size}
          onConfirm={() => void submitSell()}
          onCancel={() => setConfirmSell(null)}
        />
      )}
    </section>
  )
}
