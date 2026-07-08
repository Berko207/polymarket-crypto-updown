import { cn } from '@/lib/utils'
import { useBotStatus } from '@/queries/bot'
import { EXIT_META, fmtAgo, fmtCountdown, sideArrow, sideCls, tradeResolvedWin } from '@/lib/botFormat'
import { formatPnlUsd } from '@/lib/positionPnl'
import { BotHistoryDialog } from './BotHistoryDialog'

/**
 * Live monitor for the local bot: what it's holding right now (with unrealized
 * P&L and time left in each window) and a feed of its most-recent closes. Reads
 * the same /status poll as BotControlPanel, so it renders nothing when the bot
 * is offline (the control panel already shows the offline hint).
 */
export function BotMonitorPanel() {
  const status = useBotStatus()
  const s = status.isError ? undefined : status.data
  if (!s) return null

  const open = s.openPositions ?? []
  const openLive = open.filter((p) => p.phase === 'live' || p.msRemaining == null || p.msRemaining > 0)
  const openSettling = open.filter(
    (p) => p.phase !== 'live' && p.msRemaining != null && p.msRemaining <= 0,
  )
  const openKeys = new Set(open.map((p) => `${p.coin}-${p.timeframe}-${p.side}`))
  const recent = (s.recentActivity ?? s.recentClosed ?? [])
    .filter((r) => r.status !== 'open' && !openKeys.has(`${r.coin}-${r.timeframe}-${r.side}`))
    .slice(0, 8)
  const isMaker = s.strategy === 'maker'
  const m = s.maker
  const now = Date.now()
  const modeLabel = s.mode === 'live' ? 'live' : s.mode === 'dry' ? 'paper' : 'record'
  const sum = s.summary
  const sumPnl = sum?.pnl ?? 0
  const openPnl = openLive.reduce((acc, p) => acc + (p.unrealizedPnl ?? 0), 0)
  const settlingPnl = openSettling.reduce((acc, p) => acc + (p.unrealizedPnl ?? 0), 0)
  const totalPnl = sumPnl + openPnl + settlingPnl
  const sumStaked = sum?.staked ?? 0

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/60 p-4">
      <div className="flex items-center justify-between">
        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
          Bot monitor
        </p>
        <span className="flex items-center gap-2">
          {sum && (sum.settled > 0 || open.length > 0) ? (
            <span
              className={cn(
                'text-[0.65rem] font-semibold tabular-nums',
                totalPnl >= 0 ? 'text-up' : 'text-down',
              )}
              title={
                openLive.length > 0 || openSettling.length > 0
                  ? `Settled ${sumPnl >= 0 ? '+' : ''}$${sumPnl.toFixed(2)}` +
                    (openLive.length > 0
                      ? ` · live ${openPnl >= 0 ? '+' : ''}$${openPnl.toFixed(2)}`
                      : '') +
                    (openSettling.length > 0
                      ? ` · settling ${settlingPnl >= 0 ? '+' : ''}$${settlingPnl.toFixed(2)}`
                      : '')
                  : undefined
              }
            >
              {modeLabel} {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
              {sumStaked > 0 && openLive.length === 0 && openSettling.length === 0
                ? ` · ${((totalPnl / sumStaked) * 100).toFixed(0)}%`
                : ''}
            </span>
          ) : null}
          <span className="text-[0.65rem] text-muted-foreground">watching {s.scopes.length} markets</span>
          <BotHistoryDialog />
        </span>
      </div>

      {isMaker && m ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground/70">
              Maker inventory · {m.inventory.length}
            </p>
            <span className="flex items-center gap-1.5 text-[0.6rem] text-muted-foreground">
              <span
                title="Fill model — L1 assumes front-of-queue; L2 models queue depth. These are paper-sim fills, not live executions."
                className="rounded bg-sky-500/15 px-1 py-0.5 font-semibold tabular-nums text-sky-300"
              >
                {m.fillModel} sim
              </span>
              <span className={cn('size-1.5 rounded-full', m.feedConnected ? 'bg-up' : 'bg-muted-foreground')} />
              <span className="tabular-nums">
                {m.fills} fills · {m.openQuotes} quotes
              </span>
            </span>
          </div>
          {m.inventory.length === 0 ? (
            <p className="text-[0.7rem] text-muted-foreground">flat — no inventory</p>
          ) : (
            m.inventory.map((iv) => (
              <div
                key={`${iv.coin}-${iv.timeframe}`}
                className="flex items-center justify-between gap-2 text-[0.72rem] tabular-nums"
              >
                <span className="text-foreground">
                  {iv.coin}/{iv.timeframe}
                </span>
                <span
                  title={`long ${iv.upShares.toFixed(1)} up / ${iv.downShares.toFixed(1)} down`}
                  className={cn(
                    'font-semibold',
                    iv.net > 0 ? 'text-up' : iv.net < 0 ? 'text-down' : 'text-muted-foreground',
                  )}
                >
                  {iv.net > 0 ? '+' : ''}
                  {iv.net.toFixed(1)} net
                </span>
              </div>
            ))
          )}
          {m.quotes.length > 0 && (
            <div className="flex flex-col gap-1 border-t border-border/60 pt-1.5">
              <p className="text-[0.55rem] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Resting quotes
              </p>
              {m.quotes.map((q, i) => (
                <div
                  key={`${q.coin}-${q.timeframe}-${q.side}-${i}`}
                  className="flex items-center justify-between gap-2 text-[0.68rem] tabular-nums text-muted-foreground"
                >
                  <span className="flex items-center gap-1.5">
                    <span className={cn('font-semibold', sideCls(q.side))}>{sideArrow(q.side)}</span>
                    {q.coin}/{q.timeframe}
                  </span>
                  <span>
                    {q.price.toFixed(3)} × {q.size.toFixed(1)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
      <>
      <div className="flex flex-col gap-1.5">
        <p className="text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Open · {openLive.length}
          {s.pendingCloses ? (
            <span className="ml-1 text-amber-300">· closing {s.pendingCloses}</span>
          ) : null}
        </p>
        {openLive.length === 0 ? (
          <p className="text-[0.7rem] text-muted-foreground">no open positions</p>
        ) : (
          openLive.map((p) => {
            const up = (p.unrealizedPnl ?? 0) >= 0
            const won = p.phase === 'won'
            const lost = p.phase === 'lost'
            const settling = p.phase === 'settling'
            return (
              <div
                key={`${p.coin}-${p.timeframe}-${p.side}`}
                className="flex items-center justify-between gap-2 text-[0.72rem] tabular-nums"
              >
                <span className="flex items-center gap-1.5">
                  <span className={cn('font-semibold', sideCls(p.side))}>{sideArrow(p.side)}</span>
                  <span className="text-foreground">
                    {p.coin}/{p.timeframe}
                  </span>
                  {won ? (
                    <span
                      title={p.outcome ? `oracle ${p.outcome}` : undefined}
                      className="rounded bg-up-soft px-1 py-0.5 text-[0.55rem] font-semibold text-up"
                    >
                      won
                    </span>
                  ) : lost ? (
                    <span
                      title={p.outcome ? `oracle ${p.outcome}` : undefined}
                      className="rounded bg-down-soft px-1 py-0.5 text-[0.55rem] font-semibold text-down"
                    >
                      lost
                    </span>
                  ) : settling ? (
                    <span className="rounded bg-secondary px-1 py-0.5 text-[0.55rem] font-semibold text-muted-foreground">
                      settling
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground">
                  {p.entryPrice.toFixed(2)}→{p.mark != null ? p.mark.toFixed(2) : '—'}
                </span>
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      'font-semibold',
                      p.unrealizedPnl == null
                        ? 'text-muted-foreground'
                        : up
                          ? 'text-up'
                          : 'text-down',
                    )}
                  >
                    {p.unrealizedPnl == null
                      ? '—'
                      : `${up ? '+' : ''}$${p.unrealizedPnl.toFixed(2)}`}
                  </span>
                  <span className="w-9 text-right text-muted-foreground">
                    {p.redeemable ? 'redeem' : fmtCountdown(p.msRemaining)}
                  </span>
                </span>
              </div>
            )
          })
        )}
      </div>

      {openSettling.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2">
          <p className="text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground/70">
            Settling · {openSettling.length}
          </p>
          {openSettling.map((p) => {
            const up = (p.unrealizedPnl ?? 0) >= 0
            const won = p.phase === 'won'
            const lost = p.phase === 'lost'
            const settling = p.phase === 'settling'
            return (
              <div
                key={`settling-${p.coin}-${p.timeframe}-${p.side}`}
                className="flex items-center justify-between gap-2 text-[0.72rem] tabular-nums"
              >
                <span className="flex items-center gap-1.5">
                  <span className={cn('font-semibold', sideCls(p.side))}>{sideArrow(p.side)}</span>
                  <span className="text-foreground">
                    {p.coin}/{p.timeframe}
                  </span>
                  {won ? (
                    <span
                      title={p.outcome ? `oracle ${p.outcome}` : undefined}
                      className="rounded bg-up-soft px-1 py-0.5 text-[0.55rem] font-semibold text-up"
                    >
                      won
                    </span>
                  ) : lost ? (
                    <span
                      title={p.outcome ? `oracle ${p.outcome}` : undefined}
                      className="rounded bg-down-soft px-1 py-0.5 text-[0.55rem] font-semibold text-down"
                    >
                      lost
                    </span>
                  ) : settling ? (
                    <span className="rounded bg-secondary px-1 py-0.5 text-[0.55rem] font-semibold text-muted-foreground">
                      settling
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground">
                  {p.entryPrice.toFixed(2)}→{p.mark != null ? p.mark.toFixed(2) : '—'}
                </span>
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      'font-semibold',
                      p.unrealizedPnl == null
                        ? 'text-muted-foreground'
                        : up
                          ? 'text-up'
                          : 'text-down',
                    )}
                  >
                    {p.unrealizedPnl == null
                      ? '—'
                      : `${up ? '+' : ''}$${p.unrealizedPnl.toFixed(2)}`}
                  </span>
                  <span className="w-9 text-right text-muted-foreground">
                    {p.redeemable ? 'redeem' : 'end'}
                  </span>
                </span>
              </div>
            )
          })}
        </div>
      )}
      </>
      )}

      {recent.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2">
          <p className="text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground/70">Recent</p>
          {recent.map((r, i) => {
            const isOpen = r.status === 'open'
            const meta = !isOpen && r.exitReason ? EXIT_META[r.exitReason] : null
            const pnl = r.pnl ?? 0
            const resolved =
              'oracleOutcome' in r
                ? tradeResolvedWin(r.side, r.oracleOutcome, r.pnl)
                : tradeResolvedWin(r.side, undefined, r.pnl)
            const label = isOpen
              ? 'open'
              : meta?.label ?? (resolved == null ? '—' : resolved ? 'Won' : 'Lost')
            const cls = isOpen
              ? 'bg-secondary text-muted-foreground'
              : meta?.cls ??
                (resolved == null
                  ? 'bg-secondary text-muted-foreground'
                  : resolved
                    ? 'bg-up-soft text-up'
                    : 'bg-down-soft text-down')
            const pnlUp = pnl >= 0
            const when = isOpen
              ? ('entryT' in r && r.entryT ? r.entryT : 0)
              : (r.settleT ?? ('entryT' in r ? r.entryT : 0) ?? 0)
            return (
              <div
                key={`${when}-${r.coin}-${r.timeframe}-${i}`}
                className="flex items-center justify-between gap-2 text-[0.72rem] tabular-nums"
              >
                <span className="flex items-center gap-1.5">
                  <span className={cn('font-semibold', sideCls(r.side))}>{sideArrow(r.side)}</span>
                  <span className="text-foreground">
                    {r.coin}/{r.timeframe}
                  </span>
                </span>
                <span className={cn('rounded px-1 py-0.5 text-[0.58rem] font-semibold', cls)}>{label}</span>
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      'font-semibold',
                      isOpen ? 'text-muted-foreground' : pnlUp ? 'text-up' : 'text-down',
                    )}
                  >
                    {isOpen ? `@ ${r.entryPrice.toFixed(2)}` : formatPnlUsd(pnl)}
                  </span>
                  <span className="w-9 text-right text-muted-foreground">{fmtAgo(now - when)}</span>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
