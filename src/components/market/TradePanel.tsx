import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { MIN_BUY_USD, warmTradingPath } from '@/lib/api'
import { formatPercent } from '@/lib/polymarket'
import { rememberMarketTokens } from '@/lib/tokenLabels'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useOrderActions } from '@/hooks/useOrderActions'
import { type OutcomeSide } from '@/components/common/OutcomeBadge'
import type { ParsedMarket } from '@/lib/types'

type SizeMode = 'usdc' | 'shares'

function buyPrice(market: ParsedMarket, outcome: OutcomeSide): number | null {
  return outcome === 'up' ? (market.bestAskUp ?? market.upPrice) : (market.bestAskDown ?? market.downPrice)
}

export function TradePanel({
  market,
  coinSymbol,
  subtitle,
  disabled = false,
}: {
  market: ParsedMarket
  coinSymbol: string
  subtitle: string
  usdcBalance?: number
  disabled?: boolean
}) {
  const actions = useOrderActions()
  const [sizeMode, setSizeMode] = useState<SizeMode>('usdc')
  const [usdcAmount, setUsdcAmount] = useState(1)
  const [size, setSize] = useState(1)
  const [placing, setPlacing] = useState<OutcomeSide | null>(null)

  const prefetch = useCallback(
    (outcome: OutcomeSide) => {
      const tokenId = outcome === 'up' ? market.upTokenId : market.downTokenId
      if (tokenId) void warmTradingPath([tokenId])
    },
    [market.upTokenId, market.downTokenId],
  )

  const refPrice = buyPrice(market, 'up') || market.upPrice || 0.5

  const orderUsd = (outcome: OutcomeSide): number => {
    const price = buyPrice(market, outcome)
    if (sizeMode === 'usdc') return Math.max(MIN_BUY_USD, usdcAmount)
    if (!price) return MIN_BUY_USD
    return Math.max(MIN_BUY_USD, size * price)
  }

  const switchSizeMode = (next: SizeMode) => {
    if (next === sizeMode) return
    if (next === 'usdc') setUsdcAmount(Math.max(MIN_BUY_USD, Math.round(size * refPrice)))
    else setSize(Math.max(1, Math.round(usdcAmount / refPrice) || 1))
    setSizeMode(next)
  }

  const buy = async (outcome: OutcomeSide) => {
    if (disabled || placing) return
    const tokenId = outcome === 'up' ? market.upTokenId : market.downTokenId
    const ask = buyPrice(market, outcome)
    if (!tokenId) return toast.error('Token ID unavailable for this outcome')
    if (ask == null || !Number.isFinite(ask)) return toast.error('No price available to quote this order')
    if (!market.isLive) return toast.error('Market is not open for trading')

    const label = `${coinSymbol} ${outcome === 'up' ? 'Up' : 'Down'}`
    setPlacing(outcome)
    rememberMarketTokens(market.upTokenId, market.downTokenId, subtitle)
    try {
      await actions.buy({
        tokenId,
        amountUsd: orderUsd(outcome),
        price: ask,
        label,
        // Authoritative gamma metadata → server skips CLOB tick/neg-risk lookups.
        tickSize: market.tickSize ?? undefined,
        negRisk: market.negRisk ?? undefined,
      })
    } catch {
      // toast surfaced in useOrderActions
    } finally {
      setPlacing(null)
    }
  }

  const estShares = (usdcAmount / refPrice).toFixed(2)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 rounded-lg bg-secondary px-3 py-2">
        <ToggleGroup
          type="single"
          value={sizeMode}
          onValueChange={(v) => v && switchSizeMode(v as SizeMode)}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="usdc">USDC</ToggleGroupItem>
          <ToggleGroupItem value="shares">Shares</ToggleGroupItem>
        </ToggleGroup>
        <label className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          {sizeMode === 'usdc' ? 'Amount' : 'Shares'}
          <Input
            type="number"
            inputMode="decimal"
            className="h-8 w-24 text-right font-bold tabular-nums"
            min={sizeMode === 'usdc' ? MIN_BUY_USD : 1}
            step={1}
            value={sizeMode === 'usdc' ? usdcAmount : size}
            onChange={(e) => {
              const raw = Number(e.target.value)
              if (sizeMode === 'usdc') setUsdcAmount(Math.max(MIN_BUY_USD, raw || MIN_BUY_USD))
              else setSize(Math.max(1, raw || 1))
            }}
            disabled={Boolean(placing)}
          />
        </label>
      </div>
      <p className="text-right text-xs text-muted-foreground">
        {sizeMode === 'usdc'
          ? `≈ ${estShares} shares · min $${MIN_BUY_USD}`
          : `Est. $${Math.max(MIN_BUY_USD, refPrice * size).toFixed(2)} per side`}
      </p>

      <div className="grid grid-cols-2 gap-2.5">
        {(['up', 'down'] as const).map((outcome) => (
          <button
            key={outcome}
            type="button"
            onPointerEnter={() => prefetch(outcome)}
            onPointerDown={() => prefetch(outcome)}
            onClick={() => void buy(outcome)}
            disabled={!market.isLive || placing === outcome || disabled}
            className={cn(
              'flex flex-col items-center gap-1 rounded-xl border px-3 py-4 transition active:scale-[0.98] disabled:opacity-55',
              outcome === 'up'
                ? 'border-up/40 bg-up-soft text-up'
                : 'border-down/40 bg-down-soft text-down',
            )}
          >
            <span className="text-sm font-semibold opacity-90">
              {placing === outcome ? 'Placing…' : `Buy ${outcome === 'up' ? 'Up' : 'Down'}`}
            </span>
            <span className="text-2xl font-extrabold leading-none tabular-nums">
              {formatPercent(outcome === 'up' ? market.upPrice : market.downPrice)}
            </span>
            {(() => {
              const bid = outcome === 'up' ? market.bestBidUp : market.bestBidDown
              const ask = outcome === 'up' ? market.bestAskUp : market.bestAskDown
              return bid != null && ask != null ? (
                <span className="text-[0.65rem] tabular-nums opacity-70">
                  {formatPercent(bid)} – {formatPercent(ask)}
                </span>
              ) : null
            })()}
          </button>
        ))}
      </div>
    </div>
  )
}
