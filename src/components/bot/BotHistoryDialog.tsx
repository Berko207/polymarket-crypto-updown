import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useBotHistory, useBotStatus } from '@/queries/bot'
import { EXIT_META, formatCertaintyConfigShort, formatCertaintyEntryDetail, sideArrow, sideCls } from '@/lib/botFormat'
import type { HistoryFilters, TradeHistoryRow } from '@/lib/botControl'

const PAGE = 100

// MODE = real vs simulated money (dry/live). Kept verbose so it can't be read as
// a strategy — "Live" (real $) is a mode, "Value" (below) is a strategy.
const MODE_OPTS = [
  { v: 'dry', label: 'Paper (simulated $)' },
  { v: 'live', label: 'Live (real $)' },
  { v: 'all', label: 'All modes' },
]
const STRAT_OPTS = [
  { v: 'all', label: 'Any strategy' },
  { v: 'swing', label: 'Swing strategy' },
  { v: 'value', label: 'Value strategy' },
  { v: 'certainty', label: 'Easy strategy' },
  { v: 'maker', label: 'Maker strategy' },
]
const STATUS_OPTS = [
  { v: 'all', label: 'Any status' },
  { v: 'closed', label: 'Closed (scalp)' },
  { v: 'settled', label: 'Settled' },
  { v: 'open', label: 'Open' },
]
const OUTCOME_OPTS = [
  { v: 'all', label: 'Win + loss' },
  { v: 'win', label: 'Wins only' },
  { v: 'loss', label: 'Losses only' },
]
const REASON_OPTS = [
  { v: 'all', label: 'Any exit' },
  ...Object.entries(EXIT_META).map(([v, m]) => ({ v, label: m.label })),
]

/** Local-day epoch-ms bounds from a `<input type="date">` value (YYYY-MM-DD). */
function dayStartMs(d: string): number | undefined {
  if (!d) return undefined
  const ms = new Date(`${d}T00:00:00`).getTime()
  return Number.isFinite(ms) ? ms : undefined
}
function dayEndMs(d: string): number | undefined {
  if (!d) return undefined
  const ms = new Date(`${d}T23:59:59.999`).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

/** entry_t epoch-ms → local "MM/DD HH:MM:SS". */
function fmtWhen(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[0.55rem] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

const selectCls =
  'h-7 rounded-md border border-border bg-secondary px-1.5 text-xs text-foreground outline-none focus:border-primary'

function ResultCell({ t }: { t: TradeHistoryRow }) {
  if (t.status === 'open') {
    return <span className="rounded bg-secondary px-1 py-0.5 text-[0.58rem] font-semibold text-muted-foreground">open</span>
  }
  const meta = t.exitReason ? EXIT_META[t.exitReason] : null
  const won = (t.pnl ?? 0) >= 0
  const label = meta?.label ?? (won ? 'Won' : 'Lost')
  const cls = meta?.cls ?? (won ? 'bg-up-soft text-up' : 'bg-down-soft text-down')
  return <span className={cn('rounded px-1 py-0.5 text-[0.58rem] font-semibold', cls)}>{label}</span>
}

/**
 * Filterable grid of the bot's full trade history. Reads the bot's local
 * `/history` endpoint (paper + live rows live in the same SQLite table). Opens
 * from a trigger button; only fetches while open. Bot-offline / older-build
 * cases surface as an inline hint rather than an empty grid.
 */
export function BotHistoryDialog() {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(0)
  const [modeSynced, setModeSynced] = useState(false)
  const [f, setF] = useState({
    mode: 'dry',
    strategy: 'all',
    coin: 'all',
    timeframe: 'all',
    status: 'all',
    reason: 'all',
    outcome: 'all',
    from: '',
    to: '',
  })
  // Any filter change resets to the first page.
  const set = (patch: Partial<typeof f>) => {
    setF((cur) => ({ ...cur, ...patch }))
    setPage(0)
  }

  const statusQ = useBotStatus()
  const s = statusQ.isError ? undefined : statusQ.data
  const scopes = s?.scopes ?? []
  const coins = [...new Set(scopes.map((x) => x.split('/')[0]))]
  const tfs = s?.availableTimeframes ?? [...new Set(scopes.map((x) => x.split('/')[1]))]

  // Default history mode to the bot's active mode when the dialog first opens.
  useEffect(() => {
    if (!open) {
      setModeSynced(false)
      return
    }
    if (modeSynced || !s?.mode || s.mode === 'record') return
    setF((cur) => ({ ...cur, mode: s.mode === 'live' ? 'live' : 'dry' }))
    setModeSynced(true)
  }, [open, s?.mode, modeSynced])

  const filters: HistoryFilters = {
    mode: f.mode === 'all' ? undefined : f.mode,
    strategy: f.strategy === 'all' ? undefined : f.strategy,
    coin: f.coin === 'all' ? undefined : f.coin,
    timeframe: f.timeframe === 'all' ? undefined : f.timeframe,
    status: f.status === 'all' ? undefined : f.status,
    reason: f.reason === 'all' ? undefined : f.reason,
    outcome: f.outcome === 'all' ? undefined : f.outcome,
    from: dayStartMs(f.from),
    to: dayEndMs(f.to),
    limit: PAGE,
    offset: page * PAGE,
  }

  const history = useBotHistory(filters, open)
  const data = history.data
  const rows = data?.rows ?? []
  const total = data?.total ?? 0
  const sum = data?.summary
  const hit = sum && sum.realized > 0 ? (sum.wins / sum.realized) * 100 : null
  const roi = sum && sum.staked > 0 ? (sum.pnl / sum.staked) * 100 : null
  const rangeStart = total === 0 ? 0 : page * PAGE + 1
  const rangeEnd = page * PAGE + rows.length

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="rounded-md bg-secondary px-2 py-0.5 text-[0.62rem] font-semibold text-muted-foreground transition hover:text-foreground"
        >
          History
        </button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Trade history</DialogTitle>
          <DialogDescription>
            {sum
              ? `${total} trade${total === 1 ? '' : 's'} · ${sum.realized} realized · ${
                  hit != null ? `${hit.toFixed(0)}% hit` : '—'
                } · ${sum.pnl >= 0 ? '+' : ''}$${sum.pnl.toFixed(2)}${
                  roi != null ? ` (${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%)` : ''
                }`
              : 'Paper + live trades from the bot, newest first.'}
          </DialogDescription>
        </DialogHeader>

        {/* Filters */}
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Mode">
            <select className={selectCls} value={f.mode} onChange={(e) => set({ mode: e.target.value })}>
              {MODE_OPTS.map((o) => (
                <option key={o.v} value={o.v}>{o.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Strategy">
            <select className={selectCls} value={f.strategy} onChange={(e) => set({ strategy: e.target.value })}>
              {STRAT_OPTS.map((o) => (
                <option key={o.v} value={o.v}>{o.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Coin">
            <select className={selectCls} value={f.coin} onChange={(e) => set({ coin: e.target.value })}>
              <option value="all">All coins</option>
              {coins.map((c) => (
                <option key={c} value={c}>{c.toUpperCase()}</option>
              ))}
            </select>
          </Field>
          <Field label="Timeframe">
            <select className={selectCls} value={f.timeframe} onChange={(e) => set({ timeframe: e.target.value })}>
              <option value="all">All TFs</option>
              {tfs.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="Result">
            <select className={selectCls} value={f.outcome} onChange={(e) => set({ outcome: e.target.value })}>
              {OUTCOME_OPTS.map((o) => (
                <option key={o.v} value={o.v}>{o.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Exit">
            <select className={selectCls} value={f.reason} onChange={(e) => set({ reason: e.target.value })}>
              {REASON_OPTS.map((o) => (
                <option key={o.v} value={o.v}>{o.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select className={selectCls} value={f.status} onChange={(e) => set({ status: e.target.value })}>
              {STATUS_OPTS.map((o) => (
                <option key={o.v} value={o.v}>{o.label}</option>
              ))}
            </select>
          </Field>
          <Field label="From">
            <input type="date" className={selectCls} value={f.from} onChange={(e) => set({ from: e.target.value })} />
          </Field>
          <Field label="To">
            <input type="date" className={selectCls} value={f.to} onChange={(e) => set({ to: e.target.value })} />
          </Field>
          {(f.from || f.to || f.coin !== 'all' || f.timeframe !== 'all' || f.strategy !== 'all' ||
            f.status !== 'all' || f.reason !== 'all' || f.outcome !== 'all' || f.mode !== 'dry') && (
            <button
              type="button"
              onClick={() =>
                set({ mode: 'dry', strategy: 'all', coin: 'all', timeframe: 'all', status: 'all', reason: 'all', outcome: 'all', from: '', to: '' })
              }
              className="h-7 rounded-md px-2 text-[0.62rem] font-semibold text-muted-foreground hover:text-foreground"
            >
              Reset
            </button>
          )}
        </div>

        {/* Grid */}
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border">
          {history.isError ? (
            <p className="p-4 text-center text-xs text-amber-300">
              Couldn’t load history — is the bot running this build? Restart with{' '}
              <code className="rounded bg-secondary px-1 py-0.5">pnpm bot:paper</code>.
            </p>
          ) : history.isLoading && rows.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">No trades match these filters.</p>
          ) : (
            <table className="w-full min-w-[860px] text-[0.72rem] tabular-nums">
              <thead className="sticky top-0 z-10 bg-background">
                <tr className="border-b border-border text-left text-[0.6rem] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-1.5 font-semibold">When</th>
                  <th className="px-2 py-1.5 font-semibold">Market</th>
                  <th className="px-2 py-1.5 font-semibold">Side</th>
                  <th className="px-2 py-1.5 font-semibold">Strat</th>
                  <th className="px-2 py-1.5 font-semibold">Easy cfg</th>
                  <th className="px-2 py-1.5 font-semibold">Mode</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Entry</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Exit</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Size</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Cost</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Fee</th>
                  <th className="px-2 py-1.5 text-right font-semibold">P&amp;L</th>
                  <th className="px-2 py-1.5 font-semibold">Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const fee = t.entryFee + (t.exitFee ?? 0)
                  const pnlUp = (t.pnl ?? 0) >= 0
                  const easyCfg = formatCertaintyConfigShort(t)
                  const easyTip = formatCertaintyEntryDetail(t)
                  return (
                    <tr key={t.id} className="border-b border-border/50 last:border-0 hover:bg-secondary/40">
                      <td className="whitespace-nowrap px-2 py-1 text-muted-foreground">{fmtWhen(t.entryT)}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-foreground">{t.coin}/{t.timeframe}</td>
                      <td className={cn('px-2 py-1 font-semibold', sideCls(t.side))}>{sideArrow(t.side)} {t.side}</td>
                      <td className="px-2 py-1 text-muted-foreground">{t.strategy}</td>
                      <td
                        className="max-w-[9rem] truncate px-2 py-1 font-mono text-[0.62rem] text-emerald-300/90"
                        title={easyTip ?? undefined}
                      >
                        {easyCfg ?? (t.strategy === 'certainty' ? '—' : '')}
                      </td>
                      <td className="px-2 py-1">
                        <span
                          title={t.orderId ?? undefined}
                          className={cn(
                            'rounded px-1 py-0.5 text-[0.58rem] font-semibold',
                            t.mode === 'live' ? 'bg-down-soft text-down' : 'bg-secondary text-muted-foreground',
                          )}
                        >
                          {t.mode === 'live' ? 'LIVE' : 'paper'}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-right text-muted-foreground">{t.entryPrice.toFixed(3)}</td>
                      <td className="px-2 py-1 text-right text-muted-foreground">
                        {t.exitPrice != null ? t.exitPrice.toFixed(3) : '—'}
                      </td>
                      <td className="px-2 py-1 text-right text-muted-foreground">{t.size.toFixed(1)}</td>
                      <td className="px-2 py-1 text-right text-muted-foreground">${t.cost.toFixed(2)}</td>
                      <td className="px-2 py-1 text-right text-muted-foreground">{fee > 0 ? fee.toFixed(3) : '—'}</td>
                      <td
                        className={cn(
                          'px-2 py-1 text-right font-semibold',
                          t.pnl == null ? 'text-muted-foreground' : pnlUp ? 'text-up' : 'text-down',
                        )}
                      >
                        {t.pnl == null ? '—' : `${pnlUp ? '+' : ''}$${t.pnl.toFixed(2)}`}
                      </td>
                      <td className="px-2 py-1"><ResultCell t={t} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between text-[0.7rem] text-muted-foreground">
          <span>
            {total > 0 ? `Showing ${rangeStart}–${rangeEnd} of ${total}` : 'No matching trades'}
            {history.isFetching && rows.length > 0 ? ' · updating…' : ''}
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              disabled={page === 0 || history.isFetching}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded-md bg-secondary px-2 py-1 font-semibold text-foreground transition hover:bg-secondary/70 disabled:opacity-40"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={rangeEnd >= total || history.isFetching}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-md bg-secondary px-2 py-1 font-semibold text-foreground transition hover:bg-secondary/70 disabled:opacity-40"
            >
              Next
            </button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
