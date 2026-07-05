/** Shared formatting for the bot control + monitor panels. */

// Swing exit reasons → short label + accent (green take-profit, red stop, amber panic).
export const EXIT_META: Record<string, { label: string; cls: string }> = {
  'take-profit': { label: 'TP', cls: 'bg-up-soft text-up' },
  'stop-loss': { label: 'Stop', cls: 'bg-down-soft text-down' },
  'time-stop': { label: 'Time', cls: 'bg-secondary text-muted-foreground' },
  'edge-gone': { label: 'Edge', cls: 'bg-secondary text-muted-foreground' },
  'regime-panic': { label: 'Panic', cls: 'bg-amber-500/15 text-amber-300' },
}

/** ms remaining → "m:ss" (— when unknown). */
export function fmtCountdown(ms: number | null): string {
  if (ms == null) return '—'
  const s = Math.max(0, Math.floor(ms / 1000))
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
