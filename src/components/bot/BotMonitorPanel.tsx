import { cn } from '@/lib/utils'
import { useBotStatus } from '@/queries/bot'
import { EXIT_META, fmtAgo, fmtCountdown, sideArrow, sideCls } from '@/lib/botFormat'

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
  const now = Date.now()

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/60 p-4">
      <div className="flex items-center justify-between">
        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
          Bot monitor
        </p>
        <span className="text-[0.65rem] text-muted-foreground">watching {s.scopes.length} markets</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Open · {open.length}
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
