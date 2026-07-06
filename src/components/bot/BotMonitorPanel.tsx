import { cn } from '@/lib/utils'
import { useBotStatus } from '@/queries/bot'
import { EXIT_META, fmtAgo, fmtCountdown, sideArrow, sideCls } from '@/lib/botFormat'
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
  const recent = s.recentClosed ?? []
  const isMaker = s.strategy === 'maker'
  const m = s.maker
  const now = Date.now()
  const modeLabel = s.mode === 'live' ? 'live' : s.mode === 'dry' ? 'paper' : 'record'
  const sum = s.summary
  const sumPnl = sum?.pnl ?? 0
  const sumStaked = sum?.staked ?? 0

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/60 p-4">
      <div className="flex items-center justify-between">
        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
          Bot monitor
        </p>
        <span className="flex items-center gap-2">
          {sum && sum.settled > 0 ? (
            <span
              className={cn(
                'text-[0.65rem] font-semibold tabular-nums',
                sumPnl >= 0 ? 'text-up' : 'text-down',
              )}
            >
              {modeLabel} {sumPnl >= 0 ? '+' : ''}${sumPnl.toFixed(2)}
              {sumStaked > 0 ? ` · ${((sumPnl / sumStaked) * 100).toFixed(0)}%` : ''}
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
      <div className="flex flex-col gap-1.5">
        <p className="text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Open · {open.length}
          {s.pendingCloses ? (
            <span className="ml-1 text-amber-300">· closing {s.pendingCloses}</span>
          ) : null}
        </p>
        {open.length === 0 ? (
          <p className="text-[0.7rem] text-muted-foreground">no open positions</p>
        ) : (
          open.map((p) => {
            const up = (p.unrealizedPnl ?? 0) >= 0
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
                </span>
                <span className="text-muted-foreground">
                  {p.entryPrice.toFixed(2)}→{p.mark != null ? p.mark.toFixed(2) : '—'}
                </span>
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      'font-semibold',
                      p.unrealizedPnl == null ? 'text-muted-foreground' : up ? 'text-up' : 'text-down',
                    )}
                  >
                    {p.unrealizedPnl == null ? '—' : `${up ? '+' : ''}$${p.unrealizedPnl.toFixed(2)}`}
                  </span>
                  <span className="w-9 text-right text-muted-foreground">{fmtCountdown(p.msRemaining)}</span>
                </span>
              </div>
            )
          })
        )}
      </div>
      )}

      {recent.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2">
          <p className="text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground/70">Recent</p>
          {recent.map((r, i) => {
            const meta = r.exitReason ? EXIT_META[r.exitReason] : null
            const label = meta?.label ?? (r.pnl >= 0 ? 'Won' : 'Lost')
            const cls = meta?.cls ?? (r.pnl >= 0 ? 'bg-up-soft text-up' : 'bg-down-soft text-down')
            const up = r.pnl >= 0
            return (
              <div
                key={`${r.settleT}-${r.coin}-${r.timeframe}-${i}`}
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
                  <span className={cn('font-semibold', up ? 'text-up' : 'text-down')}>
                    {up ? '+' : ''}${r.pnl.toFixed(2)}
                  </span>
                  <span className="w-9 text-right text-muted-foreground">{fmtAgo(now - r.settleT)}</span>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
