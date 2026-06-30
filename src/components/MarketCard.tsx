import { useEffect, useRef, useState } from 'react'
import { placeOrder } from '../lib/api'
import {
  formatCountdown,
  formatPercent,
  formatVolume,
  getCountdownTarget,
} from '../lib/polymarket'
import { getCoin, getTimeframe } from '../lib/config'
import type { ParsedMarket } from '../lib/types'
import { OrderConfirmDialog } from './OrderConfirmDialog'

interface MarketCardProps {
  market: ParsedMarket
  updateHint?: string
  canTrade?: boolean
  usdcBalance?: number
  onOrderPlaced?: () => void
}

type Outcome = 'up' | 'down'

function buyPrice(market: ParsedMarket, outcome: Outcome): number | null {
  if (outcome === 'up') {
    return market.bestAskUp ?? market.upPrice
  }
  return market.bestAskDown ?? market.downPrice
}

function tokenIdFor(market: ParsedMarket, outcome: Outcome): string | null {
  return outcome === 'up' ? market.upTokenId : market.downTokenId
}

export function MarketCard({ market, updateHint, canTrade, usdcBalance, onOrderPlaced }: MarketCardProps) {
  const coin = getCoin(market.coin)
  const timeframe = getTimeframe(market.timeframe)
  const countdownInfo = getCountdownTarget(market)
  const [countdown, setCountdown] = useState(() => formatCountdown(countdownInfo.target))
  const [countdownLabel, setCountdownLabel] = useState(countdownInfo.label)
  const [priceFlash, setPriceFlash] = useState(false)
  const [size, setSize] = useState(5)
  const [placing, setPlacing] = useState<Outcome | null>(null)
  const [confirmOutcome, setConfirmOutcome] = useState<Outcome | null>(null)
  const [tradeMessage, setTradeMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const prevPrices = useRef({ up: market.upPrice, down: market.downPrice })

  useEffect(() => {
    const tick = () => {
      const info = getCountdownTarget(market)
      setCountdownLabel(info.label)
      setCountdown(formatCountdown(info.target))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [market])

  useEffect(() => {
    const prev = prevPrices.current
    if (prev.up !== market.upPrice || prev.down !== market.downPrice) {
      setPriceFlash(true)
      const id = setTimeout(() => setPriceFlash(false), 600)
      prevPrices.current = { up: market.upPrice, down: market.downPrice }
      return () => clearTimeout(id)
    }
  }, [market.upPrice, market.downPrice])

  const requestBuy = (outcome: Outcome) => {
    if (!canTrade || placing) return

    const tokenId = tokenIdFor(market, outcome)
    const price = buyPrice(market, outcome)

    if (!tokenId) {
      setTradeMessage({ type: 'err', text: 'Token ID unavailable for this outcome' })
      return
    }
    if (price == null || !Number.isFinite(price)) {
      setTradeMessage({ type: 'err', text: 'No price available to quote this order' })
      return
    }
    if (!market.isLive) {
      setTradeMessage({ type: 'err', text: 'Market is not open for trading' })
      return
    }

    setTradeMessage(null)
    setConfirmOutcome(outcome)
  }

  const submitBuy = async (outcome: Outcome) => {
    const tokenId = tokenIdFor(market, outcome)
    const price = buyPrice(market, outcome)
    if (!tokenId || price == null) return

    setConfirmOutcome(null)
    setPlacing(outcome)
    setTradeMessage(null)

    try {
      const result = await placeOrder({
        tokenId,
        side: 'BUY',
        price,
        size,
      })
      const id = result.orderId ? ` · ${result.orderId.slice(0, 8)}…` : ''
      setTradeMessage({
        type: 'ok',
        text: `Buy ${outcome === 'up' ? 'Up' : 'Down'} submitted${id}`,
      })
      onOrderPlaced?.()
    } catch (error) {
      setTradeMessage({
        type: 'err',
        text: error instanceof Error ? error.message : 'Order failed',
      })
    } finally {
      setPlacing(null)
    }
  }

  const upPct = market.upPrice * 100
  const downPct = market.downPrice * 100
  const trading = Boolean(canTrade)
  const confirmPrice = confirmOutcome ? buyPrice(market, confirmOutcome) : null

  return (
    <article className="market-card">
      <header className="market-header">
        <div className="market-title-row">
          <span className="market-coin-badge" style={{ background: coin.color }}>
            {coin.symbol}
          </span>
          <div>
            <h2 className="market-title">{coin.name} Up or Down</h2>
            <p className="market-subtitle">{timeframe.label} · {market.title.split(' - ').slice(1).join(' - ') || market.title}</p>
          </div>
        </div>
        <div className="market-header-right">
          <div className="market-clock" aria-live="polite" title={updateHint}>
            <span className="market-clock-label">{countdownLabel}</span>
            <span className="market-clock-value">{countdown}</span>
          </div>
          <div className={`live-badge ${market.isLive ? 'live' : 'upcoming'}`}>
            <span className="live-dot" />
            {market.isLive ? 'Live' : 'Closed'}
          </div>
        </div>
      </header>

      <div className={`odds-ring ${priceFlash ? 'price-flash' : ''}`}>
        <div className="odds-center">
          <span className="odds-label">Up chance</span>
          <span className="odds-value">{formatPercent(market.upPrice)}</span>
        </div>
        <svg viewBox="0 0 120 120" className="odds-svg" aria-hidden="true">
          <circle cx="60" cy="60" r="52" fill="none" stroke="var(--border)" strokeWidth="8" />
          <circle
            cx="60"
            cy="60"
            r="52"
            fill="none"
            stroke="var(--up)"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${upPct * 3.27} 327`}
            transform="rotate(-90 60 60)"
          />
        </svg>
      </div>

      {trading && (
        <div className="trade-controls">
          <label className="trade-size-label">
            Shares
            <input
              type="number"
              className="trade-size-input"
              min={1}
              step={1}
              value={size}
              onChange={(e) => setSize(Math.max(1, Number(e.target.value) || 1))}
              disabled={Boolean(placing)}
            />
          </label>
          <span className="trade-hint">
            Est. ${((buyPrice(market, 'up') ?? market.upPrice) * size).toFixed(2)} per side
          </span>
        </div>
      )}

      <div className="up-down-grid">
        {trading ? (
          <>
            <button
              type="button"
              className="outcome-btn up"
              onClick={() => requestBuy('up')}
              disabled={!market.isLive || placing !== null}
            >
              <span className="outcome-label">{placing === 'up' ? 'Placing…' : 'Buy Up'}</span>
              <span className="outcome-price">{formatPercent(market.upPrice)}</span>
              {market.bestBidUp != null && market.bestAskUp != null && (
                <span className="outcome-bid">
                  {formatPercent(market.bestBidUp)} – {formatPercent(market.bestAskUp)}
                </span>
              )}
            </button>
            <button
              type="button"
              className="outcome-btn down"
              onClick={() => requestBuy('down')}
              disabled={!market.isLive || placing !== null}
            >
              <span className="outcome-label">{placing === 'down' ? 'Placing…' : 'Buy Down'}</span>
              <span className="outcome-price">{formatPercent(market.downPrice)}</span>
              {market.bestBidDown != null && market.bestAskDown != null && (
                <span className="outcome-bid">
                  {formatPercent(market.bestBidDown)} – {formatPercent(market.bestAskDown)}
                </span>
              )}
            </button>
          </>
        ) : (
          <>
            <a
              href={market.polymarketUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="outcome-btn up"
            >
              <span className="outcome-label">Up</span>
              <span className="outcome-price">{formatPercent(market.upPrice)}</span>
              {market.bestBidUp != null && market.bestAskUp != null && (
                <span className="outcome-bid">
                  {formatPercent(market.bestBidUp)} – {formatPercent(market.bestAskUp)}
                </span>
              )}
            </a>
            <a
              href={market.polymarketUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="outcome-btn down"
            >
              <span className="outcome-label">Down</span>
              <span className="outcome-price">{formatPercent(market.downPrice)}</span>
              {market.bestBidDown != null && market.bestAskDown != null && (
                <span className="outcome-bid">
                  {formatPercent(market.bestBidDown)} – {formatPercent(market.bestAskDown)}
                </span>
              )}
            </a>
          </>
        )}
      </div>

      {tradeMessage && (
        <p className={`trade-feedback ${tradeMessage.type === 'ok' ? 'ok' : 'err'}`}>
          {tradeMessage.text}
        </p>
      )}

      <div className="probability-bar" aria-hidden="true">
        <div className="prob-up" style={{ width: `${Math.min(100, Math.max(0, upPct))}%` }} />
        <div className="prob-down" style={{ width: `${Math.min(100, Math.max(0, downPct))}%` }} />
      </div>

      <div className="stats-row">
        <div className="stat">
          <span className="stat-label">Volume</span>
          <span className="stat-value">{formatVolume(market.volume)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Liquidity</span>
          <span className="stat-value">{formatVolume(market.liquidity)}</span>
        </div>
      </div>

      {market.priceChange1h != null && (
        <p className={`price-change ${market.priceChange1h >= 0 ? 'positive' : 'negative'}`}>
          1h change: {market.priceChange1h >= 0 ? '+' : ''}
          {Math.round(market.priceChange1h * 100)}¢
        </p>
      )}

      <a
        href={market.polymarketUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="trade-link secondary"
      >
        {trading ? 'View on Polymarket →' : 'Trade on Polymarket →'}
      </a>

      {confirmOutcome && confirmPrice != null && (
        <OrderConfirmDialog
          outcome={confirmOutcome}
          coinSymbol={coin.symbol}
          price={confirmPrice}
          size={size}
          usdcBalance={usdcBalance}
          onConfirm={() => void submitBuy(confirmOutcome)}
          onCancel={() => setConfirmOutcome(null)}
        />
      )}
    </article>
  )
}
