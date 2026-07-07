/** Shared formatting for the bot control + monitor panels. */

// Swing exit reasons → short label + accent (green take-profit, red stop, amber panic).
export const EXIT_META: Record<string, { label: string; cls: string }> = {
  'take-profit': { label: 'TP', cls: 'bg-up-soft text-up' },
  'stop-loss': { label: 'Stop', cls: 'bg-down-soft text-down' },
  'time-stop': { label: 'Time', cls: 'bg-secondary text-muted-foreground' },
  'edge-gone': { label: 'Edge', cls: 'bg-secondary text-muted-foreground' },
  'regime-panic': { label: 'Panic', cls: 'bg-amber-500/15 text-amber-300' },
  'low-prob': { label: 'Cut', cls: 'bg-down-soft text-down' },
  'strategy-switch': { label: 'Switch', cls: 'bg-secondary text-muted-foreground' },
  redeem: { label: 'Redeem', cls: 'bg-up-soft text-up' },
  'window-end': { label: 'Window', cls: 'bg-secondary text-muted-foreground' },
}

/** ms remaining → "m:ss" (end when window over, — when unknown). */
export function fmtCountdown(ms: number | null): string {
  if (ms == null) return '—'
  if (ms <= 0) return 'end'
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** ms elapsed → compact "12s" / "4m" / "2h". */
export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h`
}

export const sideArrow = (side: 'up' | 'down'): string => (side === 'up' ? '▲' : '▼')
export const sideCls = (side: 'up' | 'down'): string => (side === 'up' ? 'text-up' : 'text-down')

/** Won/lost from oracle outcome when known, else from realized P&L. */
export function tradeResolvedWin(
  side: 'up' | 'down',
  oracleOutcome: 'up' | 'down' | null | undefined,
  pnl: number | null | undefined,
): boolean | null {
  if (oracleOutcome === 'up' || oracleOutcome === 'down') return side === oracleOutcome
  if (pnl != null) return pnl >= 0
  return null
}

/** Config knobs stored on Easy/certainty trade rows. */
export interface CertaintyTradeConfig {
  cfgEntryWithinSec: number
  cfgMinWinProb: number
  cfgMinEdge: number
  cfgMaxAsk: number
  cfgMinZ: number
  cfgMaxCoins: number
  cfgSignalSource: string
}

export function formatCertaintyConfigFromRow(c: CertaintyTradeConfig): string {
  return (
    `T-${c.cfgEntryWithinSec}s · P≥${(c.cfgMinWinProb * 100).toFixed(0)}% · ` +
    `edge≥${(c.cfgMinEdge * 100).toFixed(0)}¢ · ask≤${(c.cfgMaxAsk * 100).toFixed(0)}¢ · max ${c.cfgMaxCoins}`
  )
}

export function certaintyRowHasSnapshot(t: {
  cfgEntryWithinSec?: number | null
}): boolean {
  return t.cfgEntryWithinSec != null
}

/** Entry metrics + config for history tooltips. */
export function formatCertaintyEntryDetail(t: {
  entryPWin?: number | null
  entryZ?: number | null
  entryMsRemaining?: number | null
  cfgEntryWithinSec?: number | null
  cfgMinWinProb?: number | null
  cfgMinEdge?: number | null
  cfgMaxAsk?: number | null
  cfgMinZ?: number | null
  cfgMaxCoins?: number | null
  cfgSignalSource?: string | null
  signalEdge?: number
}): string | null {
  if (t.cfgEntryWithinSec == null || t.cfgMinWinProb == null) return null
  const cfg = formatCertaintyConfigFromRow({
    cfgEntryWithinSec: t.cfgEntryWithinSec,
    cfgMinWinProb: t.cfgMinWinProb,
    cfgMinEdge: t.cfgMinEdge ?? 0,
    cfgMaxAsk: t.cfgMaxAsk ?? 0,
    cfgMinZ: t.cfgMinZ ?? 0,
    cfgMaxCoins: t.cfgMaxCoins ?? 0,
    cfgSignalSource: t.cfgSignalSource ?? 'flat',
  })
  const sec = t.entryMsRemaining != null ? `${Math.round(t.entryMsRemaining / 1000)}s left` : '—'
  const p = t.entryPWin != null ? `P ${(t.entryPWin * 100).toFixed(1)}%` : '—'
  const z = t.entryZ != null ? `z ${t.entryZ.toFixed(2)}` : '—'
  const edge = t.signalEdge != null ? `edge ${(t.signalEdge * 100).toFixed(1)}¢` : '—'
  return `${p} · ${z} · ${edge} · ${sec}\n${cfg} · z≥${t.cfgMinZ ?? 0} · ${t.cfgSignalSource ?? 'flat'}`
}

export function formatCertaintyConfigShort(t: {
  cfgEntryWithinSec?: number | null
  cfgMinWinProb?: number | null
  cfgMinEdge?: number | null
  cfgMaxAsk?: number | null
  cfgMaxCoins?: number | null
}): string | null {
  if (t.cfgEntryWithinSec == null || t.cfgMinWinProb == null) return null
  return (
    `T-${t.cfgEntryWithinSec} · P${(t.cfgMinWinProb * 100).toFixed(0)} · ` +
    `e${((t.cfgMinEdge ?? 0) * 100).toFixed(0)} · a${((t.cfgMaxAsk ?? 0) * 100).toFixed(0)} · n${t.cfgMaxCoins ?? '?'}`
  )
}
