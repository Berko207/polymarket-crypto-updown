export type UpdateMode = 'live' | 'balanced' | 'saver'

export interface UpdateModeConfig {
  id: UpdateMode
  label: string
  description: string
  useWebSocket: boolean
  /** Min ms between price UI updates (WebSocket modes only). */
  throttleMs: number
  /** How often to refresh market metadata + fallback prices. */
  pollMs: number
}

export const BALANCED_INTERVAL = {
  minMs: 500,
  maxMs: 15_000,
  stepMs: 500,
  defaultMs: 5_000,
} as const

export const UPDATE_MODES: UpdateModeConfig[] = [
  {
    id: 'live',
    label: 'Live',
    description: 'Instant · Wi‑Fi',
    useWebSocket: true,
    throttleMs: 0,
    pollMs: 30_000,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Adjustable interval',
    useWebSocket: true,
    throttleMs: BALANCED_INTERVAL.defaultMs,
    pollMs: 30_000,
  },
  {
    id: 'saver',
    label: 'Saver',
    description: 'Every 30s · low data',
    useWebSocket: false,
    throttleMs: 0,
    pollMs: 30_000,
  },
]

const MODE_STORAGE_KEY = 'pm-update-mode'
const INTERVAL_STORAGE_KEY = 'pm-balanced-interval-ms'

export function formatIntervalMs(ms: number): string {
  const sec = ms / 1000
  return Number.isInteger(sec) ? `${sec}s` : `${sec.toFixed(1)}s`
}

export function formatBalancedDescription(ms: number): string {
  return `Every ${formatIntervalMs(ms)}`
}

export function clampBalancedIntervalMs(ms: number): number {
  const { minMs, maxMs, stepMs } = BALANCED_INTERVAL
  const clamped = Math.min(maxMs, Math.max(minMs, ms))
  return Math.round(clamped / stepMs) * stepMs
}

export function resolveUpdateConfig(mode: UpdateMode, balancedIntervalMs: number): UpdateModeConfig {
  const base = UPDATE_MODES.find((m) => m.id === mode) ?? UPDATE_MODES[0]
  if (mode !== 'balanced') return base

  const interval = clampBalancedIntervalMs(balancedIntervalMs)
  return {
    ...base,
    throttleMs: interval,
    description: formatBalancedDescription(interval),
  }
}

function suggestedMode(): UpdateMode {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; type?: string } })
    .connection
  if (conn?.saveData) return 'saver'
  if (conn?.type === 'cellular') return 'balanced'
  return 'live'
}

export function loadUpdateMode(): UpdateMode {
  try {
    const stored = localStorage.getItem(MODE_STORAGE_KEY)
    if (stored === 'live' || stored === 'balanced' || stored === 'saver') return stored
  } catch {
    // private browsing, etc.
  }
  return suggestedMode()
}

export function saveUpdateMode(mode: UpdateMode): void {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode)
  } catch {
    // ignore
  }
}

export function loadBalancedIntervalMs(): number {
  try {
    const stored = localStorage.getItem(INTERVAL_STORAGE_KEY)
    if (stored) {
      const parsed = Number(stored)
      if (Number.isFinite(parsed)) return clampBalancedIntervalMs(parsed)
    }
  } catch {
    // ignore
  }
  return BALANCED_INTERVAL.defaultMs
}

export function saveBalancedIntervalMs(ms: number): void {
  try {
    localStorage.setItem(INTERVAL_STORAGE_KEY, String(clampBalancedIntervalMs(ms)))
  } catch {
    // ignore
  }
}
