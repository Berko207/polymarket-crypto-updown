import { useState, useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { TriangleAlert } from 'lucide-react'
import { MIN_BUY_USD, warmTradingPath } from '@/lib/api'
import { formatPercent } from '@/lib/polymarket'
import { rememberMarketTokens } from '@/lib/tokenLabels'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useOrderActions } from '@/hooks/useOrderActions'
import { type OutcomeSide } from '@/components/common/OutcomeBadge'
import type { VolRegime } from '@/lib/regime'
import type { ParsedMarket } from '@/lib/types'

/** How long a panic-regime buy stays armed before the confirm resets. */
const PANIC_ARM_MS = 5_000

type SizeMode = 'usdc' | 'shares'

/** Best ask only — midpoint is below the touch and poisons the server's buy ceiling. */
function buyAsk(market: ParsedMarket, outcome: OutcomeSide): number | null {
  return outcome === 'up' ? market.bestAskUp : market.bestAskDown
}

function buyPrice(market: ParsedMarket, outcome: OutcomeSide): number {
  return buyAsk(market, outcome) ?? (outcome === 'up' ? market.upPrice : market.downPrice) ?? 0.5
}

export function TradePanel({
  market,
  coinSymbol,
  subtitle,
  disabled = false,
  quotesLive = false,
  regime = null,
  regimeRatio = null,
}: {
  market: ParsedMarket
  coinSymbol: string
  subtitle: string
  usdcBalance?: number
  disabled?: boolean
  /** True when the CLOB socket is streaming this market — a null ask then means the book really is empty. */
  quotesLive?: boolean
  /** Live vol regime — 'panic' arms a confirm-to-trade gate on buys. */
  regime?: VolRegime | null
  /** σ_fast / σ_slow behind the regime label, for the gate message. */
  regimeRatio?: number | null
}) {
  const actions = useOrderActions()
  const [sizeMode, setSizeMode] = useState<SizeMode>('usdc')
  const [usdcAmount, setUsdcAmount] = useState(1)
  const [size, setSize] = useState(1)
  const [placing, setPlacing] = useState<OutcomeSide | null>(null)
  // Sides that just bounced off an empty/thin book ("no match" / unmatched). Cleared
  // after a short cooldown — long enough to stop instant re-clicks, short enough to
  // retry once makers re-quote.
  const [thinBook, setThinBook] = useState<{ up: boolean; down: boolean }>({
    up: false,
    down: false,
  })
  const flagThinBook = (outcome: OutcomeSide) => {
    setThinBook((s) => ({ ...s, [outcome]: true }))
    setTimeout(() => setThinBook((s) => ({ ...s, [outcome]: false })), 8_000)
  }

  // Panic-regime risk gate: when realized vol spikes, a market buy can fill
  // adversely as the book gaps, so require a deliberate second click to confirm.
  // The arm self-resets after a few seconds and clears when panic subsides.
  const panic = regime === 'panic'
  const [armed, setArmed] = useState<OutcomeSide | null>(null)
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disarm = useCallback(() => {
    setArmed(null)
    if (disarmTimer.current) {
      clearTimeout(disarmTimer.current)
      disarmTimer.current = null
    }
  }, [])
  useEffect(() => {
    if (!panic) disarm()
  }, [panic, disarm])
  // New window (or unmount) → start disarmed; a stale confirm must not carry
  // across a rollover into a different market.
  useEffect(() => disarm, [market.upTokenId, disarm])

  const prefetch = useCallback(
    (outcome: OutcomeSide) => {
      const tokenId = outcome === 'up' ? market.upTokenId : market.downTokenId
      if (tokenId) void warmTradingPath([tokenId])
    },
    [market.upTokenId, market.downTokenId],
  )

  const refPrice = buyPrice(market, 'up')

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
    // First click during a panic regime arms rather than submits.
    if (panic && armed !== outcome) {
      setArmed(outcome)
      if (disarmTimer.current) clearTimeout(disarmTimer.current)
      disarmTimer.current = setTimeout(() => setArmed(null), PANIC_ARM_MS)
      return
    }
    disarm()
    const tokenId = outcome === 'up' ? market.upTokenId : market.downTokenId
    const ask = buyAsk(market, outcome)
    if (!tokenId) return toast.error('Token ID unavailable for this outcome')
    if (ask == null || !Number.isFinite(ask)) {
      return toast.error('No ask on the book — wait for live quotes')
    }
    if (!market.isLive) return toast.error('Market is not open for trading')

    const label = `${coinSymbol} ${outcome === 'up' ? 'Up' : 'Down'}`
    setPlacing(outcome)
    rememberMarketTokens(market.upTokenId, market.downTokenId, subtitle)
    try {
      const result = await actions.buy({
        tokenId,
        amountUsd: orderUsd(outcome),
        price: ask,
        label,
        tickSize: market.tickSize ?? undefined,
        negRisk: market.negRisk ?? undefined,
        fillMeta: {
          outcome: outcome === 'up' ? 'Up' : 'Down',
          eventSlug: market.eventSlug,
          title: market.title,
          timeframe: market.timeframe,
          upTokenId: market.upTokenId,
          downTokenId: market.downTokenId,
        },
      })
      if ((result.status ?? '').toLowerCase() === 'unmatched') flagThinBook(outcome)
    } catch (e) {
      // Toast surfaced in useOrderActions; reflect empty-book rejections on the button.
      if (e instanceof Error && /no match|liquidity/i.test(e.message)) flagThinBook(outcome)
    } finally {
      setPlacing(null)
    }
  }

  const upMid = market.upPrice > 0 ? market.upPrice : null
  const downMid = market.downPrice > 0 ? market.downPrice : null
  const estUp = upMid != null ? usdcAmount / upMid : null
  const estDown = downMid != null ? usdcAmount / downMid : null

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
          ? estUp != null && estDown != null
            ? `≈ ${estUp.toFixed(2)} Up · ${estDown.toFixed(2)} Down shares @ mid · min $${MIN_BUY_USD}`
            : `min $${MIN_BUY_USD}`
          : `Est. $${Math.max(MIN_BUY_USD, refPrice * size).toFixed(2)} per side`}
      </p>

      {panic && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[0.7rem] font-medium text-amber-300">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span>
            Panic regime{regimeRatio != null ? ` — vol ${regimeRatio.toFixed(1)}× baseline` : ''}. Fills
            can gap; buys need a second tap to confirm.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        {(['up', 'down'] as const).map((outcome) => {
          const armedThis = panic && armed === outcome
          const bid = outcome === 'up' ? market.bestBidUp : market.bestBidDown
          const ask = outcome === 'up' ? market.bestAskUp : market.bestAskDown
          // Only trust "no ask" as "book empty" while the socket is streaming — REST
          // never fills the Down book, so a null ask in saver mode proves nothing.
          const bookEmpty = quotesLive && ask == null
          const blocked = bookEmpty || thinBook[outcome]
          return (
            <button
              key={outcome}
              type="button"
              onPointerEnter={() => prefetch(outcome)}
              onPointerDown={() => prefetch(outcome)}
              onClick={() => void buy(outcome)}
              disabled={!market.isLive || placing === outcome || disabled || blocked}
              className={cn(
                'flex flex-col items-center gap-1 rounded-xl border px-3 py-4 transition active:scale-[0.98] disabled:opacity-55',
                outcome === 'up'
                  ? 'border-up/40 bg-up-soft text-up'
                  : 'border-down/40 bg-down-soft text-down',
                blocked && 'border-amber-500/50',
                armedThis && 'border-amber-500 ring-2 ring-amber-500/60',
              )}
            >
              <span className="text-sm font-semibold opacity-90">
                {placing === outcome
                  ? 'Placing…'
                  : armedThis
                    ? `Confirm ${outcome === 'up' ? 'Up' : 'Down'}?`
                    : `Buy ${outcome === 'up' ? 'Up' : 'Down'}`}
              </span>
              <span className="text-2xl font-extrabold leading-none tabular-nums">
                {formatPercent(outcome === 'up' ? market.upPrice : market.downPrice)}
              </span>
              {blocked ? (
                <span className="text-[0.65rem] font-medium text-amber-400">
                  {thinBook[outcome] ? 'No liquidity — retrying soon' : 'No asks — book empty'}
                </span>
              ) : armedThis ? (
                <span className="text-[0.65rem] font-medium text-amber-400">Tap again to confirm</span>
              ) : bid != null && ask != null ? (
                <span className="text-[0.65rem] tabular-nums opacity-70">
                  {formatPercent(bid)} – {formatPercent(ask)}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
