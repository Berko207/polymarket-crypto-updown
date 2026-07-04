import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useBotHalt, useBotMode, useBotStatus } from '@/queries/bot'
import type { BotMode } from '@/lib/botControl'

// Record = observe/log only · Paper = simulated fills, no real money · Live =
// real orders (gated). "Paper" is the wire id 'dry' — the bot/DB keep that id.
const MODES: { id: BotMode; label: string }[] = [
  { id: 'record', label: 'Record' },
  { id: 'dry', label: 'Paper' },
  { id: 'live', label: 'Live' },
]

const modeLabel = (id: BotMode): string => MODES.find((m) => m.id === id)?.label ?? id

/**
 * Bot execution-mode switch + live status for the local bot. Talks to the bot's
 * control server (localhost only). The Record/Paper/Live switch is always shown;
 * it's disabled with an "offline" hint until the bot is running and reachable —
 * so the control is always visible, not hidden when the bot isn't up. Production
 * can't reach the operator's machine, so it stays offline there.
 */
export function BotControlPanel() {
  const status = useBotStatus()
  const mode = useBotMode()
  const halt = useBotHalt()
  const s = status.data

  const switchMode = (next: BotMode) => {
    if (!s || next === s.mode || mode.isPending) return
    mode.mutate(next, {
      onError: (e) => toast.error(e instanceof Error ? e.message : 'mode switch failed'),
      onSuccess: () => toast.success(`Bot → ${modeLabel(next)}`),
    })
  }

  const roi = s && s.summary.staked > 0 ? (s.summary.pnl / s.summary.staked) * 100 : null
  const hit = s && s.summary.settled > 0 ? (s.summary.wins / s.summary.settled) * 100 : null

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/60 p-4">
      <div className="flex items-center justify-between">
        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
          Bot control
        </p>
        <span className="flex items-center gap-1.5 text-[0.65rem] text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', s?.connected ? 'bg-up' : 'bg-muted-foreground')} />
          {s ? `${s.connected ? 'streaming' : 'ws down'} · ${s.liveScopes}/${s.scopes.length} live` : 'offline'}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-1 rounded-lg bg-secondary p-1">
        {MODES.map((m) => {
          const active = s?.mode === m.id
          const disabled = !s || (m.id === 'live' && !s.allowLive) || mode.isPending
          return (
            <button
              key={m.id}
              type="button"
              disabled={disabled}
              onClick={() => switchMode(m.id)}
              title={
                !s
                  ? 'bot offline — run pnpm bot:paper'
                  : m.id === 'live' && !s.allowLive
                    ? 'launch the bot with --allow-live to enable'
                    : undefined
              }
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

      {!s && (
        <p className="text-center text-[0.7rem] text-muted-foreground">
          offline · run <code className="rounded bg-secondary px-1 py-0.5">pnpm bot:paper</code> to control the bot
        </p>
      )}

      {s?.mode === 'live' && (
        <p className="rounded-lg bg-down-soft px-3 py-1.5 text-center text-[0.7rem] font-semibold text-down">
          ⚠ LIVE — placing real orders
        </p>
      )}

      {s && (
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
            {s.summary.entered} trades · {s.summary.open} open
          </span>
        </div>
      )}

      {s && s.summary.settled > 0 && (
        <div className="flex items-center justify-between text-[0.7rem] tabular-nums text-muted-foreground">
          <span>
            {s.summary.settled} settled · {hit?.toFixed(0)}% hit
          </span>
          <span className={cn('font-semibold', s.summary.pnl >= 0 ? 'text-up' : 'text-down')}>
            {s.summary.pnl >= 0 ? '+' : ''}${s.summary.pnl.toFixed(2)}
            {roi != null ? ` · ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%` : ''}
          </span>
        </div>
      )}
    </div>
  )
}
