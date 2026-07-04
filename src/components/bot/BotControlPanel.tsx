import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useBotHalt, useBotMode, useBotStatus } from '@/queries/bot'
import type { BotMode } from '@/lib/botControl'

const MODES: { id: BotMode; label: string }[] = [
  { id: 'record', label: 'Record' },
  { id: 'dry', label: 'Dry' },
  { id: 'live', label: 'Live' },
]

/**
 * Dry/Live switch + live status for the local bot. Talks to the bot's control
 * server (localhost only) — shows "offline" when the bot isn't running or the
 * dashboard is deployed (production can't reach the operator's machine).
 */
export function BotControlPanel() {
  const status = useBotStatus()
  const mode = useBotMode()
  const halt = useBotHalt()
  const s = status.data

  if (!s) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-border bg-secondary/40 px-4 py-3 text-[0.7rem] text-muted-foreground">
        <span className="font-semibold uppercase tracking-wide">Bot</span>
        <span>
          offline · <code className="rounded bg-secondary px-1 py-0.5">pnpm bot:dry</code>
        </span>
      </div>
    )
  }

  const switchMode = (next: BotMode) => {
    if (next === s.mode || mode.isPending) return
    mode.mutate(next, {
      onError: (e) => toast.error(e instanceof Error ? e.message : 'mode switch failed'),
      onSuccess: () => toast.success(`Bot → ${next}`),
    })
  }

  const { pnl, staked, settled, wins, entered, open } = s.summary
  const roi = staked > 0 ? (pnl / staked) * 100 : null
  const hit = settled > 0 ? (wins / settled) * 100 : null

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/60 p-4">
      <div className="flex items-center justify-between">
        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
          Bot control
        </p>
        <span className="flex items-center gap-1.5 text-[0.65rem] text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', s.connected ? 'bg-up' : 'bg-muted-foreground')} />
          {s.connected ? 'streaming' : 'ws down'} · {s.liveScopes}/{s.scopes.length} live
        </span>
      </div>

      <div className="grid grid-cols-3 gap-1 rounded-lg bg-secondary p-1">
        {MODES.map((m) => {
          const active = s.mode === m.id
          const disabled = (m.id === 'live' && !s.allowLive) || mode.isPending
          return (
            <button
              key={m.id}
              type="button"
              disabled={disabled}
              onClick={() => switchMode(m.id)}
              title={m.id === 'live' && !s.allowLive ? 'launch the bot with --allow-live to enable' : undefined}
              className={cn(
                'rounded-md px-2 py-1.5 text-xs font-semibold transition disabled:opacity-40',
                active
                  ? m.id === 'live'
                    ? 'bg-down-soft text-down shadow-sm'
                    : 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {m.label}
            </button>
          )
        })}
      </div>

      {s.mode === 'live' && (
        <p className="rounded-lg bg-down-soft px-3 py-1.5 text-center text-[0.7rem] font-semibold text-down">
          ⚠ LIVE — placing real orders
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={halt.isPending || s.mode === 'record'}
          onClick={() =>
            halt.mutate(!s.halted, {
              onError: (e) => toast.error(e instanceof Error ? e.message : 'halt failed'),
            })
          }
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-semibold transition disabled:opacity-40',
            s.halted
              ? 'bg-amber-500/15 text-amber-300'
              : 'bg-secondary text-muted-foreground hover:text-foreground',
          )}
        >
          {s.halted ? 'Halted — resume' : 'Halt entries'}
        </button>
        <span className="text-[0.7rem] tabular-nums text-muted-foreground">
          {entered} trades · {open} open
        </span>
      </div>

      {settled > 0 && (
        <div className="flex items-center justify-between text-[0.7rem] tabular-nums text-muted-foreground">
          <span>
            {settled} settled · {hit?.toFixed(0)}% hit
          </span>
          <span className={cn('font-semibold', pnl >= 0 ? 'text-up' : 'text-down')}>
            {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
            {roi != null ? ` · ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%` : ''}
          </span>
        </div>
      )}
    </div>
  )
}
