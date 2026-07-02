import { useState } from 'react'
import { formatCents } from '@/lib/polymarket'
import { formatPositionLabel } from '@/lib/marketLabels'
import { livePositionMark } from '@/lib/positionPnl'
import { MIN_POSITION_SIZE } from '@/queries/portfolio'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { OutcomeBadge, outcomeSide } from '@/components/common/OutcomeBadge'
import { TimeframeBadge } from '@/components/common/TimeframeBadge'
import { PositionPnl } from './PositionPnl'
import { bidDepthForSize, type TokenQuote } from '@/lib/clobSocket'
import type { Position } from '@/lib/api'

function PositionPriceLine({
  bought,
  live,
}: {
  bought: number | null
  live: number | null
}) {
  if (bought == null && live == null) {
    return <span className="text-xs text-muted-foreground">—</span>
  }

  const delta =
    bought != null && live != null ? Math.round((live - bought) * 100) : null
  const liveColor =
    delta == null
      ? 'text-foreground'
      : delta > 0
        ? 'text-up'
        : delta < 0
          ? 'text-down'
          : 'text-muted-foreground'

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums">
      {bought != null && (
        <span className="text-muted-foreground">
          Bought <span className="font-semibold text-foreground">{formatCents(bought)}</span>
        </span>
      )}
      {bought != null && live != null && (
        <span className="text-muted-foreground/50" aria-hidden>
          →
        </span>
      )}
      {live != null && (
        <span className={cn('font-bold', liveColor)}>
          Now {formatCents(live)}
          {delta != null && delta !== 0 && (
            <span className="ml-1 font-semibold opacity-90">
              ({delta > 0 ? '+' : ''}
              {delta}¢)
            </span>
          )}
        </span>
      )}
    </div>
  )
}

/** What the WS bid book can absorb right now — the answer to "can I sell, and into what?". */
function BidDepthLine({ quote, size }: { quote?: TokenQuote; size: number }) {
  // Depth is WS-only; without a live book (saver mode / before first frame) show nothing.
  if (!quote || (quote.bids.length === 0 && quote.bestBid == null)) return null
  const depth = bidDepthForSize(quote, size)
  if (!depth.hasBid) {
    return <span className="text-xs font-semibold text-down tabular-nums">↘ no bids on book</span>
  }
  const shares = depth.sharesBid
  return (
    <span
      className={cn(
        'text-xs tabular-nums',
        depth.coversSize ? 'text-muted-foreground' : 'text-down',
      )}
    >
      ↘ {shares.toFixed(shares < 100 ? 1 : 0)} sh bid
      {depth.coversSize && depth.fillsAllAtPrice != null ? (
        <span className="ml-1 opacity-90">· fills ≈{formatCents(depth.fillsAllAtPrice)}</span>
      ) : (
        <span className="ml-1 opacity-90">(of {size.toFixed(0)})</span>
      )}
    </span>
  )
}

/** Popover to post a GTC limit sell that rests on the book until a buyer crosses it. */
function RestSellPopover({
  position,
  defaultPrice,
  disabled,
  onSellLimit,
}: {
  position: Position
  defaultPrice: number | null
  disabled: boolean
  onSellLimit: (position: Position, limitPrice: number) => void
}) {
  const [open, setOpen] = useState(false)
  // Cents keep the price on the tick grid (0.01 markets, and 0.01 is a valid multiple of 0.001).
  const defaultCents = defaultPrice != null ? Math.min(99, Math.max(1, Math.round(defaultPrice * 100))) : 50
  const [cents, setCents] = useState(defaultCents)
  const price = cents / 100
  const valid = cents >= 1 && cents <= 99
  const proceeds = valid ? position.size * price : null

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setCents(defaultCents)
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          className="h-6 px-1.5 text-[0.7rem] text-muted-foreground"
          disabled={disabled}
          title="Post a resting limit sell"
        >
          Rest…
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 space-y-2">
        <p className="text-xs font-semibold">Resting limit sell</p>
        <p className="text-[0.7rem] leading-snug text-muted-foreground">
          Posts a GTC sell that rests on the book and fills when a buyer crosses it — works even
          with no resting liquidity now.
        </p>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={99}
            step={1}
            value={cents}
            onChange={(e) => setCents(Math.round(Number(e.target.value)))}
            className="h-8 w-20 tabular-nums"
            aria-label="Limit price in cents"
          />
          <span className="text-xs text-muted-foreground">¢ · {position.size.toFixed(2)} sh</span>
        </div>
        <div className="flex items-center justify-between text-[0.7rem] text-muted-foreground tabular-nums">
          <span>Est. proceeds</span>
          <span className="font-semibold text-foreground">
            {proceeds != null ? `$${proceeds.toFixed(2)}` : '—'}
          </span>
        </div>
        <Button
          size="sm"
          className="w-full"
          disabled={!valid || disabled}
          onClick={() => {
            if (!valid) return
            onSellLimit(position, price)
            setOpen(false)
          }}
        >
          Post @ {cents}¢
        </Button>
      </PopoverContent>
    </Popover>
  )
}

export function PositionRow({
  position,
  quote,
  selling = false,
  sellFirst = false,
  onSell,
  onSellLimit,
}: {
  position: Position
  quote?: TokenQuote
  selling?: boolean
  sellFirst?: boolean
  onSell: (position: Position, sellPrice: number) => void
  onSellLimit?: (position: Position, limitPrice: number) => void
}) {
  const { short, timeframeLabel, asset, window } = formatPositionLabel(position)
  const detail = [asset, window].filter(Boolean).join(' · ') || short
  const side = outcomeSide(position.outcome)
  const live = livePositionMark(position, quote)
  // Sell mark is the best available price (live bid → mid/last → polled snapshot), not
  // just the WS bid: it's only a server hint (the book is walked anyway), so gating the
  // Sell button on a live bid needlessly blocks selling in saver mode / before first quote.
  const sellMark = live
  const proceeds = sellMark != null ? position.size * sellMark : null
  const avgPrice =
    position.avgPrice > 0
      ? position.avgPrice
      : position.initialValue != null && position.initialValue > 0 && position.size > 0
        ? position.initialValue / position.size
        : null
  const cost = avgPrice != null ? position.size * avgPrice : null

  return (
    <li className="flex items-start justify-between gap-3 rounded-lg bg-secondary px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <OutcomeBadge outcome={position.outcome} />
          {timeframeLabel && <TimeframeBadge label={timeframeLabel} />}
          <span className="truncate text-sm font-medium">{detail}</span>
          {sellFirst && (
            <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide text-primary">
              Sell 1st
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-col gap-1">
          <div className="text-xs text-muted-foreground tabular-nums">
            {position.size.toFixed(2)} shares
            {cost != null && <span className="ml-2">· ${cost.toFixed(2)} cost</span>}
          </div>
          <PositionPriceLine bought={avgPrice} live={live} />
          {!position.redeemable && <BidDepthLine quote={quote} size={position.size} />}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <PositionPnl position={position} quote={quote} compact />
        <div className="flex items-center gap-1">
          {onSellLimit && !position.redeemable && position.size >= MIN_POSITION_SIZE && (
            <RestSellPopover
              position={position}
              defaultPrice={sellMark}
              disabled={selling}
              onSellLimit={onSellLimit}
            />
          )}
          <Button
            size="xs"
            variant="ghost"
            className={cn('h-6 px-2', side === 'up' ? 'text-up' : 'text-down')}
            disabled={selling || sellMark == null || position.redeemable || position.size < MIN_POSITION_SIZE}
            onClick={() => sellMark != null && onSell(position, sellMark)}
          >
            {selling
              ? 'Selling…'
              : position.redeemable
                ? 'Resolved'
                : proceeds != null
                  ? `Sell ≈$${proceeds.toFixed(2)}`
                  : 'Sell'}
          </Button>
        </div>
      </div>
    </li>
  )
}
