import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { MIN_BUY_USD } from '@/lib/api'
import { Input } from '@/components/ui/input'
import { useBotHalt, useBotMode, useBotStake, useBotStatus } from '@/queries/bot'
import { EXIT_META } from '@/lib/botFormat'
import type { BotMode } from '@/lib/botControl'

// Record = observe/log only · Paper = simulated fills, no real money · Live =
// real orders (gated). "Paper" is the wire id 'dry' — the bot/DB keep that id.
const MODES: { id: BotMode; label: string }[] = [
  { id: 'record', label: 'Record' },
  { id: 'dry', label: 'Paper' },
  { id: 'live', label: 'Live' },
]

const modeLabel = (id: BotMode): string => MODES.find((m) => m.id === id)?.label ?? id

const STAKE_PRESETS = [1, 5, 10, 25] as const

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
  const stake = useBotStake()
  // TanStack keeps the last successful data while polling errors — without the
  // isError gate a killed bot would show "streaming" with stale PnL forever.
  const s = status.isError ? undefined : status.data
  const stakeSupported = s?.stakeUsd != null
  const serverStake = s?.stakeUsd ?? MIN_BUY_USD
  const [draftStake, setDraftStake] = useState(serverStake)

  useEffect(() => {
    setDraftStake(serverStake)
  }, [serverStake])

  const commitStake = (raw: number) => {
    if (!stakeSupported) {
      toast.error('Restart the bot (pnpm bot:paper) to enable stake control')
      return
    }
    const next = Math.max(MIN_BUY_USD, raw || MIN_BUY_USD)
    setDraftStake(next)
    if (!s || next === serverStake || stake.isPending) return
    stake.mutate(next, {
      onError: (e) => {
        const msg = e instanceof Error ? e.message : 'stake update failed'
        toast.error(msg === 'not found' ? 'Restart the bot (pnpm bot:paper) to enable stake control' : msg)
      },
      onSuccess: () => toast.success(`Stake → $${next}`),
    })
  }

  const switchMode = (next: BotMode) => {
    if (!s || next === s.mode || mode.isPending) return
    mode.mutate(next, {
      onError: (e) => toast.error(e instanceof Error ? e.message : 'mode switch failed'),
      onSuccess: () => toast.success(`Bot → ${modeLabel(next)}`),
    })
  }

  const roi = s && s.summary.staked > 0 ? (s.summary.pnl / s.summary.staked) * 100 : null
  const hit = s && s.summary.settled > 0 ? (s.summary.wins / s.summary.settled) * 100 : null
  const strategy = s?.strategy ?? 'value'
  const swingExits = s?.swingExits ?? []
  const dailyCap =
    s?.dailyTrades != null &&
    s.maxDailyTrades != null &&
    s.maxDailyTrades > 0 &&
    s.dailyTrades >= s.maxDailyTrades

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/60 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
            Bot control
          </p>
          {s && (
            <span
              title={
                strategy === 'swing'
                  ? 'Swing scalp — buys the model’s underpriced side, auto take-profit/stop'
                  : 'Value — late edge bet held to settlement'
              }
              className={cn(
                'rounded px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide',
                strategy === 'swing' ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground',
              )}
            >
              {strategy === 'swing' ? 'Swing' : 'Value'}
            </span>
          )}
          {s && strategy === 'swing' && s.swingTrigger && (
            <span
              className="text-[0.6rem] text-muted-foreground"
              title={
                s.swingTrigger === 'edge'
                  ? 'Trust the model: enter on model edge, no spike required'
                  : 'Fade: only enter when a market spike confirms the edge'
              }
            >
              {s.swingTrigger === 'edge' ? 'model' : 'fade'} · {s.swingSource}
            </span>
          )}
        </div>
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

      {s && s.mode !== 'record' && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-secondary px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">Stake per trade</span>
            <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              $
              <Input
                type="number"
                inputMode="decimal"
                className="h-7 w-20 text-right text-xs font-bold tabular-nums"
                min={MIN_BUY_USD}
                step={1}
                value={draftStake}
                disabled={!stakeSupported || stake.isPending}
                onChange={(e) => setDraftStake(Math.max(MIN_BUY_USD, Number(e.target.value) || MIN_BUY_USD))}
                onBlur={() => commitStake(draftStake)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur()
                  }
                }}
              />
            </label>
          </div>
          {!stakeSupported && (
            <p className="text-[0.65rem] text-amber-300">
              Restart the bot to enable — stop it and run{' '}
              <code className="rounded bg-secondary px-1 py-0.5">pnpm bot:paper</code>
            </p>
          )}
          <div className="flex flex-wrap gap-1">
            {STAKE_PRESETS.map((v) => (
              <button
                key={v}
                type="button"
                disabled={!stakeSupported || stake.isPending}
                onClick={() => commitStake(v)}
                className={cn(
                  'rounded px-2 py-0.5 text-[0.65rem] font-semibold tabular-nums transition disabled:opacity-40',
                  serverStake === v
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                ${v}
              </button>
            ))}
          </div>
        </div>
      )}

      {!s && (
        <p className="text-center text-[0.7rem] text-muted-foreground">
          offline · run <code className="rounded bg-secondary px-1 py-0.5">pnpm bot:paper</code> to control the bot
        </p>
      )}

      {dailyCap && (
        <p className="rounded-lg bg-amber-500/15 px-3 py-1.5 text-center text-[0.7rem] font-semibold text-amber-300">
          Daily cap reached ({s!.dailyTrades}/{s!.maxDailyTrades} entries in 24h) — no new trades until
          older ones roll off, or restart with a higher{' '}
          <code className="rounded bg-secondary px-1 py-0.5">BOT_MAX_DAILY_TRADES</code>
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
            {s.summary.settled} {strategy === 'swing' ? 'closed' : 'settled'} · {hit?.toFixed(0)}% hit
          </span>
          <span className={cn('font-semibold', s.summary.pnl >= 0 ? 'text-up' : 'text-down')}>
            {s.summary.pnl >= 0 ? '+' : ''}${s.summary.pnl.toFixed(2)}
            {roi != null ? ` · ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%` : ''}
          </span>
        </div>
      )}

      {strategy === 'swing' && swingExits.length > 0 && (
        <div className="flex flex-wrap gap-1" title="Swing exits by reason (count) — hover for win rate + P&L">
          {swingExits.map((e) => {
            const meta = EXIT_META[e.reason] ?? { label: e.reason, cls: 'bg-secondary text-muted-foreground' }
            return (
              <span
                key={e.reason}
                title={`${meta.label}: ${e.wins}/${e.n} win · pnl ${e.pnl >= 0 ? '+' : ''}$${e.pnl.toFixed(2)}`}
                className={cn('rounded px-1.5 py-0.5 text-[0.6rem] font-semibold tabular-nums', meta.cls)}
              >
                {meta.label} {e.n}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
