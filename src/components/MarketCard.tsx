import { useEffect, useRef, useState } from 'react'
import { MIN_BUY_USD, placeOrder } from '../lib/api'
import {
  formatCountdown,
  formatPercent,
  formatVolume,
  getCountdownTarget,
} from '../lib/polymarket'
import { getCoin, getTimeframe } from '../lib/config'
import type { ParsedMarket } from '../lib/types'
import { OrderConfirmDialog } from './OrderConfirmDialog'
import { MarketHoldings } from './MarketHoldings'

interface MarketCardProps {
  market: ParsedMarket
  updateHint?: string
  canTrade?: boolean
  usdcBalance?: number
  onOrderPlaced?: () => void
  holdingsRefreshKey?: number
}

type Outcome = 'up' | 'down'
type SizeMode = 'shares' | 'usdc'

function buyPrice(market: ParsedMarket, outcome: Outcome): number | null {
  if (outcome === 'up') {
    return market.bestAskUp ?? market.upPrice
  }
  return market.bestAskDown ?? market.downPrice
}

function tokenIdFor(market: ParsedMarket, outcome: Outcome): string | null {
  return outcome === 'up' ? market.upTokenId : market.downTokenId
}

export function MarketCard({ market, updateHint, canTrade, usdcBalance, onOrderPlaced, holdingsRefreshKey = 0 }: MarketCardProps) {
  const coin = getCoin(market.coin)
  const timeframe = getTimeframe(market.timeframe)
  const countdownInfo = getCountdownTarget(market)
  const [countdown, setCountdown] = useState(() => formatCountdown(countdownInfo.target))
  const [countdownLabel, setCountdownLabel] = useState(countdownInfo.label)
  const [priceFlash, setPriceFlash] = useState(false)
  const [sizeMode, setSizeMode] = useState<SizeMode>('usdc')
  const [size, setSize] = useState(1)
  const [usdcAmount, setUsdcAmount] = useState(1)
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

    const buyUsd = orderAmountUsd(outcome)
    if (buyUsd < MIN_BUY_USD) {
      setTradeMessage({ type: 'err', text: `Minimum buy is $${MIN_BUY_USD.toFixed(2)}` })
      return
    }

    setConfirmOutcome(null)
    setPlacing(outcome)
    setTradeMessage(null)

    try {
      const buyUsd = orderAmountUsd(outcome)
      const result = await placeOrder({
        tokenId,
        side: 'BUY',
        orderType: 'market',
        amount: buyUsd,
      })
      const id = result.orderId ? ` · ${result.orderId.slice(0, 8)}…` : ''
      setTradeMessage({
        type: 'ok',
        text: `Buy ${outcome === 'up' ? 'Up' : 'Down'} filled${id}`,
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
  const refPrice = buyPrice(market, 'up') ?? market.upPrice

  const orderSize = (outcome: Outcome): number => {
    const price = buyPrice(market, outcome)
    if (!price) return size
    if (sizeMode === 'usdc') return Math.ceil((usdcAmount / price) * 100) / 100
    return size
  }

  const orderAmountUsd = (outcome: Outcome): number => {
    const price = buyPrice(market, outcome)
    if (sizeMode === 'usdc') return Math.max(MIN_BUY_USD, usdcAmount)
    if (!price) return MIN_BUY_USD
    return Math.max(MIN_BUY_USD, size * price)
  }

  const switchSizeMode = (mode: SizeMode) => {
    if (mode === sizeMode) return
    if (mode === 'usdc') {
      setUsdcAmount(Math.max(MIN_BUY_USD, Number((size * refPrice).toFixed(2))))
    } else {
      setSize(Math.max(1, Math.round(usdcAmount / refPrice) || 1))
    }
    setSizeMode(mode)
  }

  const confirmPrice = confirmOutcome ? buyPrice(market, confirmOutcome) : null
  const confirmSize = confirmOutcome ? orderSize(confirmOutcome) : size
  const confirmCost = confirmOutcome ? orderAmountUsd(confirmOutcome) : usdcAmount

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
          <div className="trade-size-row">
            <div className="trade-size-mode" role="group" aria-label="Order size unit">
              <button
                type="button"
                className={sizeMode === 'usdc' ? 'active' : ''}
                onClick={() => switchSizeMode('usdc')}
                disabled={Boolean(placing)}
              >
                USDC
              </button>
              <button
                type="button"
                className={sizeMode === 'shares' ? 'active' : ''}
                onClick={() => switchSizeMode('shares')}
                disabled={Boolean(placing)}
              >
                Shares
              </button>
            </div>
            <label className="trade-size-label">
              {sizeMode === 'usdc' ? 'Amount' : 'Shares'}
              <input
                type="number"
                className="trade-size-input"
                min={sizeMode === 'usdc' ? MIN_BUY_USD : 1}
                step={sizeMode === 'usdc' ? 0.01 : 1}
                value={sizeMode === 'usdc' ? usdcAmount : size}
                onChange={(e) => {
                  const raw = Number(e.target.value)
                  if (sizeMode === 'usdc') {
                    setUsdcAmount(Math.max(MIN_BUY_USD, raw || MIN_BUY_USD))
                  } else {
                    setSize(Math.max(1, raw || 1))
                  }
                }}
                disabled={Boolean(placing)}
              />
            </label>
          </div>
          <span className="trade-hint">
            {sizeMode === 'usdc'
              ? `≈ ${(usdcAmount / refPrice).toFixed(2)} shares · min $${MIN_BUY_USD}`
              : `Est. $${Math.max(MIN_BUY_USD, refPrice * size).toFixed(2)} per side`}
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

      <MarketHoldings
        enabled={trading}
        upTokenId={market.upTokenId}
        downTokenId={market.downTokenId}
        bestBidUp={market.bestBidUp}
        bestBidDown={market.bestBidDown}
        upPrice={market.upPrice}
        downPrice={market.downPrice}
        refreshKey={holdingsRefreshKey}
        onChanged={onOrderPlaced}
      />

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
          size={confirmSize}
          estCost={confirmCost}
          usdcBalance={usdcBalance}
          onConfirm={() => void submitBuy(confirmOutcome)}
          onCancel={() => setConfirmOutcome(null)}
        />
      )}
    </article>
  )
}
