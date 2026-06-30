import { useEffect, useState } from 'react'
import { fetchAuthConfig, getStoredApiSecret } from '@/lib/apiAuth'
import { COINS, getAvailableTimeframes } from '@/lib/config'
import { useUiStore } from '@/store/ui'
import { useAccountQuery } from '@/queries/account'
import { useThemeSync } from '@/hooks/useThemeSync'
import { Header } from '@/components/layout/Header'
import { WatchlistPanel } from '@/components/watchlist/WatchlistPanel'
import { MarketDetail } from '@/components/market/MarketDetail'
import { PortfolioPanel } from '@/components/portfolio/PortfolioPanel'
import { ApiUnlock } from '@/components/account/ApiUnlock'
import { Card, CardContent } from '@/components/ui/card'
import { Toaster } from '@/components/ui/sonner'
import type { TimeframeId } from '@/lib/types'

function PanelCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="lg:sticky lg:top-[4.5rem]">
      <CardContent className="flex flex-col gap-3 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        {children}
      </CardContent>
    </Card>
  )
}

export function AppShell() {
  useThemeSync()

  const coin = useUiStore((s) => s.selectedCoin)
  const timeframe = useUiStore((s) => s.selectedTimeframe)
  const setCoin = useUiStore((s) => s.setCoin)
  const setTimeframe = useUiStore((s) => s.setTimeframe)

  const [authRequired, setAuthRequired] = useState<boolean | null>(null)
  const [authReady, setAuthReady] = useState(() => Boolean(getStoredApiSecret()))

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

  const accountEnabled = authRequired !== true || authReady
  const accountQuery = useAccountQuery(accountEnabled)
  const status = accountQuery.data ?? null
  const canTrade = status?.canTrade === true

  const account = {
    status,
    loading: accountQuery.isLoading && accountEnabled,
    error: accountQuery.isError
      ? accountQuery.error instanceof Error
        ? accountQuery.error.message
        : 'Could not load account'
      : null,
    refresh: () => void accountQuery.refetch(),
  }

  const handleTimeframe = (tf: TimeframeId) => {
    setTimeframe(tf)
    if (!getAvailableTimeframes(coin).includes(tf)) {
      const firstCoin = COINS.find((c) => getAvailableTimeframes(c.id).includes(tf))
      if (firstCoin) setCoin(firstCoin.id)
    }
  }

  if (authRequired === null) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <div className="size-8 animate-spin rounded-full border-2 border-border border-t-primary" />
      </div>
    )
  }

  if (!authReady && authRequired) {
    return (
      <>
        <ApiUnlock onUnlocked={() => setAuthReady(true)} />
        <Toaster position="top-center" />
      </>
    )
  }

  return (
    <div className="min-h-dvh">
      <Header account={account} />

      <div className="mx-auto grid max-w-6xl gap-4 px-4 py-4 lg:grid-cols-[260px_minmax(0,1fr)_340px] lg:items-start">
        <aside className="order-1">
          <PanelCard title="Watchlist">
            <WatchlistPanel
              timeframe={timeframe}
              selectedCoin={coin}
              onSelectCoin={setCoin}
              onSelectTimeframe={handleTimeframe}
            />
          </PanelCard>
        </aside>

        <main className="order-2 min-w-0">
          <MarketDetail
            key={`${coin}-${timeframe}`}
            coin={coin}
            timeframe={timeframe}
            canTrade={canTrade}
          />
        </main>

        <aside className="order-3">
          <PanelCard title="Portfolio">
            <PortfolioPanel enabled={canTrade} coin={coin} timeframe={timeframe} />
          </PanelCard>
        </aside>
      </div>

      <footer className="px-4 py-6 text-center text-xs text-muted-foreground">
        Data from Polymarket · Not financial advice
      </footer>

      <Toaster position="top-center" />
    </div>
  )
}
