import { useEffect, useRef, useState } from 'react'
import {
  formatCountdown,
  formatPercent,
  formatVolume,
  getCountdownTarget,
} from '../lib/polymarket'
import { getCoin, getTimeframe } from '../lib/config'
import type { ParsedMarket } from '../lib/types'

interface MarketCardProps {
  market: ParsedMarket
  updateHint?: string
}

export function MarketCard({ market, updateHint }: MarketCardProps) {
  const coin = getCoin(market.coin)
  const timeframe = getTimeframe(market.timeframe)
  const countdownInfo = getCountdownTarget(market)
  const [countdown, setCountdown] = useState(() => formatCountdown(countdownInfo.target))
  const [countdownLabel, setCountdownLabel] = useState(countdownInfo.label)
  const [priceFlash, setPriceFlash] = useState(false)
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

  const upPct = market.upPrice * 100
  const downPct = market.downPrice * 100

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
        <div className={`live-badge ${market.isLive ? 'live' : 'upcoming'}`} title={updateHint}>
          <span className="live-dot" />
          {market.isLive ? 'Live' : 'Closed'}
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

      <div className="up-down-grid">
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
      </div>

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
        <div className="stat">
          <span className="stat-label">{countdownLabel}</span>
          <span className="stat-value countdown">{countdown}</span>
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
        className="trade-link"
      >
        Trade on Polymarket →
      </a>
    </article>
  )
}
