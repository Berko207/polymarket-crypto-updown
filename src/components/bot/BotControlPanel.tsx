import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { MIN_BUY_USD } from '@/lib/api'
import { Input } from '@/components/ui/input'
import {
  useBotHalt,
  useBotMaker,
  useBotMaxDailyTrades,
  useBotMode,
  useBotStake,
  useBotStatus,
  useBotStrategy,
  useBotTradeTimeframes,
} from '@/queries/bot'
import { EXIT_META } from '@/lib/botFormat'
import type { BotMode, MakerPatch } from '@/lib/botControl'

// Record = observe/log only · Paper = simulated fills, no real money · Live =
// real orders (gated). "Paper" is the wire id 'dry' — the bot/DB keep that id.
const MODES: { id: BotMode; label: string }[] = [
  { id: 'record', label: 'Record' },
  { id: 'dry', label: 'Paper' },
  { id: 'live', label: 'Live' },
]

const modeLabel = (id: BotMode): string => MODES.find((m) => m.id === id)?.label ?? id

const STAKE_PRESETS = [1, 5, 10, 25] as const
const DAILY_CAP_PRESETS = [50, 100, 250, 500, 1000] as const

const STRAT_META: Record<'value' | 'swing' | 'maker', { label: string; title: string; badge: string }> = {
  value: {
    label: 'Value',
    title: 'Value — late edge bet held to settlement',
    badge: 'bg-secondary text-muted-foreground',
  },
  swing: {
    label: 'Swing',
    title: 'Swing scalp — buys the model’s underpriced side, auto take-profit/stop',
    badge: 'bg-primary/15 text-primary',
  },
  maker: {
    label: 'Maker',
    title: 'Maker — two-sided passive quotes; capture spread + rebate (paper simulation)',
    badge: 'bg-sky-500/15 text-sky-300',
  },
}

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
  const dailyCapMut = useBotMaxDailyTrades()
  const strat = useBotStrategy()
  const tradeTf = useBotTradeTimeframes()
  const makerMut = useBotMaker()
  // TanStack keeps the last successful data while polling errors — without the
  // isError gate a killed bot would show "streaming" with stale PnL forever.
  const s = status.isError ? undefined : status.data
  const stakeSupported = s?.stakeUsd != null
  const dailyCapSupported = s?.maxDailyTrades != null
  const serverStake = s?.stakeUsd ?? MIN_BUY_USD
  const serverDailyCap = s?.maxDailyTrades ?? 0
  const [draftStake, setDraftStake] = useState(serverStake)
  const [draftDailyCap, setDraftDailyCap] = useState(serverDailyCap)
  const maker = s?.maker
  const mkSpread = maker?.baseSpread
  const mkClip = maker?.clipUsd
  const mkMaxInv = maker?.maxInventory
  const [draftSpread, setDraftSpread] = useState(0.02)
  const [draftClip, setDraftClip] = useState(1)
  const [draftMaxInv, setDraftMaxInv] = useState(20)
  // Strategy + trade-timeframe control needs a bot new enough to report the universe.
  const tfSupported = s?.availableTimeframes != null
  const availableTf = s?.availableTimeframes ?? []
  const tradedTf = s?.tradeTimeframes ?? []

  useEffect(() => {
    setDraftStake(serverStake)
  }, [serverStake])

  useEffect(() => {
    setDraftDailyCap(serverDailyCap)
  }, [serverDailyCap])

  useEffect(() => {
    if (mkSpread != null) setDraftSpread(mkSpread)
  }, [mkSpread])
  useEffect(() => {
    if (mkClip != null) setDraftClip(mkClip)
  }, [mkClip])
  useEffect(() => {
    if (mkMaxInv != null) setDraftMaxInv(mkMaxInv)
  }, [mkMaxInv])

  const commitMaker = (patch: MakerPatch, label: string) => {
    if (!maker || makerMut.isPending) return
    makerMut.mutate(patch, {
      onError: (e) => {
        const msg = e instanceof Error ? e.message : 'maker update failed'
        toast.error(msg === 'not found' ? 'Restart the bot to enable maker controls' : msg)
      },
      onSuccess: () => toast.success(label),
    })
  }

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

  const commitDailyCap = (raw: number) => {
    if (!dailyCapSupported) {
      toast.error('Restart the bot to enable daily cap control')
      return
    }
    const next = Math.max(0, Math.floor(raw) || 0)
    setDraftDailyCap(next)
    if (!s || next === serverDailyCap || dailyCapMut.isPending) return
    dailyCapMut.mutate(next, {
      onError: (e) => {
        const msg = e instanceof Error ? e.message : 'daily cap update failed'
        toast.error(msg === 'not found' ? 'Restart the bot to enable daily cap control' : msg)
      },
      onSuccess: () => toast.success(`Daily cap → ${next > 0 ? next : 'default'}`),
    })
  }

  const switchMode = (next: BotMode) => {
    if (!s || next === s.mode || mode.isPending) return
    mode.mutate(next, {
      onError: (e) => toast.error(e instanceof Error ? e.message : 'mode switch failed'),
      onSuccess: () => toast.success(`Bot → ${modeLabel(next)}`),
    })
  }

  const switchStrategy = (next: 'value' | 'swing' | 'maker') => {
    if (!s || next === s.strategy || strat.isPending) return
    strat.mutate(next, {
      onError: (e) => {
        const msg = e instanceof Error ? e.message : 'strategy switch failed'
        toast.error(msg === 'not found' ? 'Restart the bot (pnpm bot:paper) to enable strategy control' : msg)
      },
      onSuccess: () => toast.success(`Strategy → ${STRAT_META[next].label}`),
    })
  }

  const toggleTf = (tf: string) => {
    if (!s || tradeTf.isPending) return
    const set = new Set(tradedTf)
    if (set.has(tf)) set.delete(tf)
    else set.add(tf)
    const next = availableTf.filter((t) => set.has(t)) // keep canonical order
    if (next.length === 0) {
      toast.error('Keep at least one timeframe on — use Halt to pause all entries')
      return
    }
    tradeTf.mutate(next, {
      onError: (e) => toast.error(e instanceof Error ? e.message : 'timeframe update failed'),
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
              title={STRAT_META[strategy].title}
              className={cn(
                'rounded px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide',
                STRAT_META[strategy].badge,
              )}
            >
              {STRAT_META[strategy].label}
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
          {s && strategy === 'maker' && s.maker && (
            <span
              className="text-[0.6rem] tabular-nums text-muted-foreground"
              title="Fill model + half-spread the maker is quoting (paper simulation)"
            >
              {s.maker.fillModel} · spread±{s.maker.baseSpread} · clip ${s.maker.clipUsd}
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
                    ? 'Live disabled in paper mode — run pnpm bot:live in a separate terminal'
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

      {s && tfSupported && (
        <div className="flex flex-col gap-2 rounded-lg bg-secondary px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">Strategy</span>
            <div className="grid grid-cols-3 gap-0.5 rounded-md bg-background/60 p-0.5">
              {(['value', 'swing', 'maker'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  disabled={strat.isPending}
                  onClick={() => switchStrategy(st)}
                  title={STRAT_META[st].title}
                  className={cn(
                    'rounded px-2 py-1 text-xs font-semibold transition disabled:opacity-40',
                    strategy === st
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {STRAT_META[st].label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">Trade timeframes</span>
              <span className="text-[0.6rem] text-muted-foreground">off = recorded, not traded</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {availableTf.map((tf) => {
                const on = tradedTf.includes(tf)
                return (
                  <button
                    key={tf}
                    type="button"
                    disabled={tradeTf.isPending}
                    onClick={() => toggleTf(tf)}
                    aria-pressed={on}
                    title={on ? `Trading ${tf} — click to record-only` : `${tf} recorded only — click to trade`}
                    className={cn(
                      'rounded px-2 py-0.5 text-[0.7rem] font-semibold tabular-nums transition disabled:opacity-40',
                      on
                        ? 'bg-primary/15 text-primary'
                        : 'bg-background/40 text-muted-foreground line-through hover:text-foreground',
                    )}
                  >
                    {tf}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {s && strategy === 'maker' && maker && s.mode !== 'record' && (
        <div className="flex flex-col gap-2 rounded-lg bg-secondary px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">Fill model</span>
            <div className="grid grid-cols-2 gap-0.5 rounded-md bg-background/60 p-0.5">
              {(['L1', 'L2'] as const).map((fm) => (
                <button
                  key={fm}
                  type="button"
                  disabled={makerMut.isPending}
                  onClick={() => maker.fillModel !== fm && commitMaker({ fillModel: fm }, `Fill model → ${fm}`)}
                  title={
                    fm === 'L1'
                      ? 'L1 — trade-through, assumes front of queue (optimistic on fill rate)'
                      : 'L2 — also models queue depth ahead of you (more realistic, fewer fills)'
                  }
                  className={cn(
                    'rounded px-3 py-1 text-xs font-semibold transition disabled:opacity-40',
                    maker.fillModel === fm
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {fm}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[0.6rem] font-medium uppercase tracking-wide text-muted-foreground">
                Half-spread
              </span>
              <Input
                type="number"
                inputMode="decimal"
                className="h-7 text-right text-xs font-bold tabular-nums"
                min={0.005}
                max={0.4}
                step={0.005}
                value={draftSpread}
                disabled={makerMut.isPending}
                onChange={(e) => setDraftSpread(Number(e.target.value) || 0)}
                onBlur={() => {
                  if (draftSpread > 0 && draftSpread !== maker.baseSpread) {
                    commitMaker({ baseSpread: draftSpread }, `Spread → ±${draftSpread}`)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[0.6rem] font-medium uppercase tracking-wide text-muted-foreground">Clip $</span>
              <Input
                type="number"
                inputMode="decimal"
                className="h-7 text-right text-xs font-bold tabular-nums"
                min={1}
                step={1}
                value={draftClip}
                disabled={makerMut.isPending}
                onChange={(e) => setDraftClip(Number(e.target.value) || 0)}
                onBlur={() => {
                  if (draftClip > 0 && draftClip !== maker.clipUsd) {
                    commitMaker({ clipUsd: draftClip }, `Clip → $${draftClip}`)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[0.6rem] font-medium uppercase tracking-wide text-muted-foreground">Max inv</span>
              <Input
                type="number"
                inputMode="numeric"
                className="h-7 text-right text-xs font-bold tabular-nums"
                min={1}
                step={1}
                value={draftMaxInv}
                disabled={makerMut.isPending}
                onChange={(e) => setDraftMaxInv(Number(e.target.value) || 0)}
                onBlur={() => {
                  if (draftMaxInv > 0 && draftMaxInv !== maker.maxInventory) {
                    commitMaker({ maxInventory: draftMaxInv }, `Max inv → ${draftMaxInv}`)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
              />
            </label>
          </div>
        </div>
      )}

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

      {s && s.mode !== 'record' && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-secondary px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Daily trade cap
              {s.dailyTrades != null && (
                <span className="ml-1.5 font-normal tabular-nums text-muted-foreground/80">
                  ({s.dailyTrades}/{serverDailyCap > 0 ? serverDailyCap : '∞'} in 24h)
                </span>
              )}
            </span>
            <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              max
              <Input
                type="number"
                inputMode="numeric"
                className="h-7 w-20 text-right text-xs font-bold tabular-nums"
                min={0}
                step={1}
                value={draftDailyCap}
                disabled={!dailyCapSupported || dailyCapMut.isPending}
                onChange={(e) => setDraftDailyCap(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                onBlur={() => commitDailyCap(draftDailyCap)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur()
                  }
                }}
              />
            </label>
          </div>
          {!dailyCapSupported && (
            <p className="text-[0.65rem] text-amber-300">
              Restart the bot to enable — stop it and run{' '}
              <code className="rounded bg-secondary px-1 py-0.5">pnpm bot:paper</code>
            </p>
          )}
          <div className="flex flex-wrap gap-1">
            {DAILY_CAP_PRESETS.map((v) => (
              <button
                key={v}
                type="button"
                disabled={!dailyCapSupported || dailyCapMut.isPending}
                onClick={() => commitDailyCap(v)}
                className={cn(
                  'rounded px-2 py-0.5 text-[0.65rem] font-semibold tabular-nums transition disabled:opacity-40',
                  serverDailyCap === v
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {v}
              </button>
            ))}
            {s.mode === 'dry' && (
              <button
                type="button"
                disabled={!dailyCapSupported || dailyCapMut.isPending}
                onClick={() => commitDailyCap(0)}
                title="0 = unlimited in paper mode"
                className={cn(
                  'rounded px-2 py-0.5 text-[0.65rem] font-semibold transition disabled:opacity-40',
                  serverDailyCap === 0
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                ∞
              </button>
            )}
          </div>
        </div>
      )}

      {!s && (
        <p className="text-center text-[0.7rem] text-muted-foreground">
          offline · run <code className="rounded bg-secondary px-1 py-0.5">pnpm dev</code> for the UI,{' '}
          <code className="rounded bg-secondary px-1 py-0.5">pnpm bot:live</code> for real orders
        </p>
      )}

      {dailyCap && (
        <p className="rounded-lg bg-amber-500/15 px-3 py-1.5 text-center text-[0.7rem] font-semibold text-amber-300">
          Daily cap reached ({s!.dailyTrades}/{s!.maxDailyTrades} entries in 24h) — no new trades until older
          ones roll off, or raise the cap above
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
