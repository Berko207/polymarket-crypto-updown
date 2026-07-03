import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useChainlinkHistory } from '@/hooks/useChainlinkHistory'
import {
  chainlinkPair,
  coinSymbol,
  cryptoPriceVariant,
  fetchCryptoPriceHistory,
  formatSpotDelta,
  formatSpotUsd,
} from '@/lib/cryptoPrice'
import { qk } from '@/queries/keys'
import { cn } from '@/lib/utils'
import type { MarketSpot } from '@/hooks/useMarketSpot'
import type { ChainlinkTick } from '@/lib/chainlinkSocket'
import type { ParsedMarket } from '@/lib/types'

const HEIGHT = 120
const PAD_Y = 8
/** Bucket ticks to ~2px so long windows stay a few hundred points. */
const PX_PER_BUCKET = 2

interface Point {
  t: number
  v: number
}

/** Min/max-preserving downsample — a plain "every Nth tick" would erase spikes,
 * and spikes are exactly what matters next to a strike. */
function downsample(ticks: ChainlinkTick[], buckets: number): Point[] {
  if (ticks.length <= buckets * 2) {
    return ticks.map((tk) => ({ t: tk.timestamp, v: tk.value }))
  }
  const t0 = ticks[0].timestamp
  const span = ticks[ticks.length - 1].timestamp - t0 || 1
  const out: Point[] = []
  let bucket = -1
  let lo: ChainlinkTick | null = null
  let hi: ChainlinkTick | null = null

  const flush = () => {
    if (!lo || !hi) return
    const first = lo.timestamp <= hi.timestamp ? lo : hi
    const second = first === lo ? hi : lo
    out.push({ t: first.timestamp, v: first.value })
    if (second !== first) out.push({ t: second.timestamp, v: second.value })
  }

  for (const tk of ticks) {
    const b = Math.min(buckets - 1, Math.floor(((tk.timestamp - t0) / span) * buckets))
    if (b !== bucket) {
      flush()
      bucket = b
      lo = hi = tk
      continue
    }
    if (!lo || tk.value < lo.value) lo = tk
    if (!hi || tk.value > hi.value) hi = tk
  }
  flush()
  return out
}

function timeLabel(ms: number, withDay = false): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return withDay ? `${d.toLocaleDateString([], { weekday: 'short' })} ${time}` : time
}

/**
 * The window's swing at a glance: Chainlink spot path against the locked strike,
 * shaded by which side is winning, with the un-elapsed window as empty runway on
 * the right. Hover reads exact price/Δ/time off the path.
 */
export function WindowPriceChart({ market, spot }: { market: ParsedMarket; spot: MarketSpot }) {
  const pair = chainlinkPair(market.coin)
  const startMs = market.startDate?.getTime() ?? 0
  const endMs = market.endDate.getTime()

  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const liveTicks = useChainlinkHistory(startMs > 0 ? pair : null, startMs)

  // The live ring buffer only reaches back ~5h (and only since page load) — for
  // anything but a fresh short window, backfill the elapsed path from Polymarket.
  const backfill = useQuery({
    queryKey: qk.cryptoPriceHistory(market.eventSlug, startMs),
    queryFn: () =>
      fetchCryptoPriceHistory(
        coinSymbol(market.coin),
        new Date(startMs).toISOString(),
        cryptoPriceVariant(market),
      ),
    enabled: pair != null && startMs > 0,
    staleTime: Infinity,
    retry: 2,
  })

  const ticks = useMemo(() => {
    const hist = backfill.data
    if (!hist?.length) return liveTicks
    const firstLive = liveTicks.length ? liveTicks[0].timestamp : Infinity
    const merged: ChainlinkTick[] = []
    for (const p of hist) {
      if (p.timestamp >= startMs && p.timestamp < firstLive) {
        merged.push({ timestamp: p.timestamp, value: p.value })
      }
    }
    return merged.length ? [...merged, ...liveTicks] : liveTicks
  }, [backfill.data, liveTicks, startMs])

  const [hover, setHover] = useState<Point | null>(null)

  const chart = useMemo(() => {
    if (!width || ticks.length < 2 || startMs <= 0) return null
    const points = downsample(ticks, Math.max(60, Math.floor(width / PX_PER_BUCKET)))

    const x0 = Math.max(startMs, points[0].t)
    const x1 = endMs
    const xSpan = x1 - x0 || 1

    let lo = Infinity
    let hi = -Infinity
    for (const p of points) {
      if (p.v < lo) lo = p.v
      if (p.v > hi) hi = p.v
    }
    if (spot.strike != null) {
      lo = Math.min(lo, spot.strike)
      hi = Math.max(hi, spot.strike)
    }
    const yPad = (hi - lo || Math.abs(hi) * 0.0005 || 1) * 0.1
    lo -= yPad
    hi += yPad

    const x = (t: number) => ((t - x0) / xSpan) * width
    const y = (v: number) => PAD_Y + (1 - (v - lo) / (hi - lo)) * (HEIGHT - PAD_Y * 2)

    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
    const strikeY = spot.strike != null ? y(spot.strike) : null
    const area =
      strikeY != null
        ? `${line}L${x(points[points.length - 1].t).toFixed(1)},${strikeY.toFixed(1)}L${x(points[0].t).toFixed(1)},${strikeY.toFixed(1)}Z`
        : null

    const last = points[points.length - 1]
    return { points, x, y, line, area, strikeY, last, x0 }
  }, [width, ticks, startMs, endMs, spot.strike])

  if (!pair || startMs <= 0) return null

  const strike = spot.strike
  const lastUp = chart && strike != null ? chart.last.v >= strike : null

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!chart) return
    const rect = e.currentTarget.getBoundingClientRect()
    const t = chart.x0 + ((e.clientX - rect.left) / rect.width) * (endMs - chart.x0)
    const pts = chart.points
    let lo = 0
    let hi = pts.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (pts[mid].t < t) lo = mid + 1
      else hi = mid
    }
    const near =
      lo > 0 && Math.abs(pts[lo - 1].t - t) < Math.abs(pts[lo].t - t) ? pts[lo - 1] : pts[lo]
    setHover(near)
  }

  return (
    <div ref={containerRef} className="relative rounded-xl border border-border bg-secondary/60 p-0">
      {chart ? (
        <>
          <svg
            width={width}
            height={HEIGHT}
            className="block touch-none"
            role="img"
            aria-label={`${market.coin.toUpperCase()} price this window versus the strike`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            {chart.area && chart.strikeY != null && (
              <>
                <clipPath id="wpc-above">
                  <rect x="0" y="0" width={width} height={chart.strikeY} />
                </clipPath>
                <clipPath id="wpc-below">
                  <rect x="0" y={chart.strikeY} width={width} height={HEIGHT - chart.strikeY} />
                </clipPath>
                <path d={chart.area} fill="var(--up)" opacity="0.14" clipPath="url(#wpc-above)" />
                <path d={chart.area} fill="var(--down)" opacity="0.14" clipPath="url(#wpc-below)" />
              </>
            )}

            {chart.strikeY != null && (
              <line
                x1="0"
                x2={width}
                y1={chart.strikeY}
                y2={chart.strikeY}
                stroke="var(--muted-foreground)"
                strokeWidth="1"
                strokeDasharray="3 4"
                opacity="0.6"
              />
            )}

            <path d={chart.line} fill="none" stroke="var(--foreground)" strokeWidth="2" strokeLinejoin="round" opacity="0.85" />

            {hover && (
              <line
                x1={chart.x(hover.t)}
                x2={chart.x(hover.t)}
                y1={PAD_Y}
                y2={HEIGHT - PAD_Y}
                stroke="var(--muted-foreground)"
                strokeWidth="1"
                opacity="0.5"
              />
            )}

            <circle
              cx={chart.x(chart.last.t)}
              cy={chart.y(chart.last.v)}
              r="3.5"
              fill={lastUp == null ? 'var(--foreground)' : lastUp ? 'var(--up)' : 'var(--down)'}
              stroke="var(--card)"
              strokeWidth="1.5"
            />
          </svg>

          {hover && (
            <div
              className="pointer-events-none absolute top-1 z-10 rounded-md border border-border bg-card px-2 py-1 text-[0.65rem] tabular-nums shadow-sm"
              style={{
                left: Math.min(Math.max(chart.x(hover.t) - 60, 4), Math.max(width - 130, 4)),
              }}
            >
              <span className="font-semibold">{formatSpotUsd(market.coin, hover.v)}</span>
              {strike != null && (
                <span className={cn('ml-1.5', hover.v >= strike ? 'text-up' : 'text-down')}>
                  {formatSpotDelta(market.coin, hover.v - strike)}
                </span>
              )}
              <span className="ml-1.5 text-muted-foreground">
                {new Date(hover.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center justify-center text-[0.65rem] text-muted-foreground" style={{ height: HEIGHT }}>
          Collecting price history…
        </div>
      )}

      <div className="flex items-center justify-between px-3 pb-2 text-[0.6rem] text-muted-foreground">
        {/* History backfill normally anchors x0 at window open; if it hasn't loaded,
            label the domain the path actually covers, not the window's nominal start. */}
        <span>{timeLabel(chart?.x0 ?? startMs, endMs - startMs > 12 * 3_600_000)}</span>
        <span>spot vs strike · Chainlink</span>
        <span>{timeLabel(endMs, endMs - startMs > 12 * 3_600_000)}</span>
      </div>
    </div>
  )
}
