import { useEffect, useState } from 'react'
import { getAvailableTimeframes } from './lib/config'
import type { CoinId, TimeframeId } from './lib/types'
import { fetchAuthConfig, getStoredApiSecret } from './lib/apiAuth'
import { CoinPicker } from './components/CoinPicker'
import { AccountStatus } from './components/AccountStatus'
import { ApiUnlock } from './components/ApiUnlock'
import { MarketCard } from './components/MarketCard'
import { OpenOrders } from './components/OpenOrders'
import { OpenOrdersBar } from './components/OpenOrdersBar'
import { TimeframeTabs } from './components/TimeframeTabs'
import { UpdateModeControl } from './components/UpdateModeControl'
import { useMarket } from './hooks/useMarket'
import { useAccount } from './hooks/useAccount'
import { usePortfolio } from './hooks/usePortfolio'
import { useUpdateMode } from './hooks/useUpdateMode'

export function AppShell() {
  const [coin, setCoin] = useState<CoinId>('btc')
  const [timeframe, setTimeframe] = useState<TimeframeId>('5m')
  const [authReady, setAuthReady] = useState(() => Boolean(getStoredApiSecret()))
  const [authRequired, setAuthRequired] = useState<boolean | null>(null)
  const [ordersRefreshKey, setOrdersRefreshKey] = useState(0)
  const { mode, config, balancedIntervalMs, selectMode, setBalancedInterval } = useUpdateMode()
  const accountEnabled = authRequired !== true || authReady
  const { status: accountStatus, loading: accountLoading, error: accountError, refresh: refreshAccount } =
    useAccount(accountEnabled)
  const { market, loading, error, refresh } = useMarket(coin, timeframe, mode, balancedIntervalMs)
  const marketMatches =
    market != null && market.coin === coin && market.timeframe === timeframe
  // While switching coin/timeframe, keep showing the previous market (dimmed,
  // trading disabled) so open orders/positions stay visible during the load.
  const marketStale = market != null && !marketMatches
  const canTrade = accountStatus?.canTrade === true
  const portfolio = usePortfolio(canTrade, ordersRefreshKey)
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null)

  const handleCancelOrder = async (orderId: string) => {
    setCancellingOrderId(orderId)
    try {
      await portfolio.cancel(orderId)
      void refreshAccount()
    } finally {
      setCancellingOrderId(null)
    }
  }

  useEffect(() => {
    fetchAuthConfig()
      .then((cfg) => {
        setAuthRequired(cfg.authRequired)
        setAuthReady(!cfg.authRequired || Boolean(getStoredApiSecret()))
      })
      .catch(() => {
        setAuthRequired(false)
        setAuthReady(true)
      })
  }, [])

  useEffect(() => {
    const available = getAvailableTimeframes(coin)
    if (!available.includes(timeframe)) {
      setTimeframe(available[0] ?? '5m')
    }
  }, [coin, timeframe])

  const handleOrderPlaced = () => {
    void refreshAccount()
    setOrdersRefreshKey((k) => k + 1)
    portfolio.refresh()
  }

  if (authRequired === null) {
    return (
      <div className="app">
        <main className="main">
          <div className="state-card loading">
            <div className="spinner" />
            <p>Loading…</p>
          </div>
        </main>
      </div>
    )
  }

  if (!authReady && authRequired) {
    return <ApiUnlock onUnlocked={() => setAuthReady(true)} />
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-icon">◆</span>
          <div>
            <h1>Crypto Up/Down</h1>
            <p className="brand-sub">Polymarket live odds</p>
          </div>
        </div>
        <div className="header-actions">
          <OpenOrders
            enabled={canTrade}
            orders={portfolio.orders}
            positions={portfolio.positions}
            loading={portfolio.loading}
            error={portfolio.error}
            onRefresh={portfolio.refresh}
            onCancel={handleCancelOrder}
            liveQuotesEnabled={config.useWebSocket}
            liveThrottleMs={config.throttleMs}
            onChanged={() => void refreshAccount()}
          />
          <AccountStatus
            status={accountStatus}
            loading={accountLoading}
            error={accountError}
            onRefresh={refreshAccount}
          />
          <UpdateModeControl
            mode={mode}
            balancedIntervalMs={balancedIntervalMs}
            onChange={selectMode}
            onBalancedIntervalChange={setBalancedInterval}
          />
          <button type="button" className="refresh-btn" onClick={() => void refresh()} aria-label="Refresh">
            ↻
          </button>
        </div>
      </header>

      <CoinPicker selected={coin} onChange={setCoin} />
      <TimeframeTabs coin={coin} selected={timeframe} onChange={setTimeframe} />

      {canTrade && (
        <OpenOrdersBar
          orders={portfolio.orders}
          positions={portfolio.positions}
          cancellingId={cancellingOrderId}
          onCancel={(id) => void handleCancelOrder(id)}
        />
      )}

      <main className="main">
        {loading && market == null && (
          <div className="state-card loading">
            <div className="spinner" />
            <p>Loading market…</p>
          </div>
        )}

        {error && market == null && (
          <div className="state-card error">
            <p>{error}</p>
            <button type="button" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        )}

        {!loading && !error && market == null && (
          <div className="state-card empty">
            <p>No active market for this coin & timeframe.</p>
          </div>
        )}

        {market && (
          <MarketCard
            key={`${coin}-${timeframe}`}
            market={market}
            stale={marketStale}
            updateHint={config.description}
            canTrade={canTrade}
            usdcBalance={accountStatus?.usdcBalance}
            onOrderPlaced={handleOrderPlaced}
            orders={portfolio.orders}
            positions={portfolio.positions}
            portfolioLoading={portfolio.loading}
            onCancelOrder={handleCancelOrder}
          />
        )}
      </main>

      <footer className="app-footer">
        <p>Data from Polymarket · Not financial advice</p>
      </footer>
    </div>
  )
}
