import { useEffect, useState } from 'react'
import { getAvailableTimeframes } from './lib/config'
import type { CoinId, TimeframeId } from './lib/types'
import { CoinPicker } from './components/CoinPicker'
import { MarketCard } from './components/MarketCard'
import { TimeframeTabs } from './components/TimeframeTabs'
import { UpdateModeControl } from './components/UpdateModeControl'
import { useMarket } from './hooks/useMarket'
import { useUpdateMode } from './hooks/useUpdateMode'

export function AppShell() {
  const [coin, setCoin] = useState<CoinId>('btc')
  const [timeframe, setTimeframe] = useState<TimeframeId>('5m')
  const { mode, config, balancedIntervalMs, selectMode, setBalancedInterval } = useUpdateMode()
  const { market, loading, error, refresh } = useMarket(coin, timeframe, mode, balancedIntervalMs)

  useEffect(() => {
    const available = getAvailableTimeframes(coin)
    if (!available.includes(timeframe)) {
      setTimeframe(available[0] ?? '5m')
    }
  }, [coin, timeframe])

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

      <main className="main">
        {loading && !market && (
          <div className="state-card loading">
            <div className="spinner" />
            <p>Loading market…</p>
          </div>
        )}

        {error && !market && (
          <div className="state-card error">
            <p>{error}</p>
            <button type="button" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        )}

        {!loading && !error && !market && (
          <div className="state-card empty">
            <p>No active market for this coin & timeframe.</p>
          </div>
        )}

        {market && <MarketCard market={market} updateHint={config.description} />}
      </main>

      <footer className="app-footer">
        <p>Data from Polymarket · Not financial advice</p>
      </footer>
    </div>
  )
}
