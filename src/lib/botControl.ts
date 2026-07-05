/**
 * Client for the local bot's control server (bot/control.ts). The bot runs on
 * the operator's machine, so this only works in local dev (dashboard on
 * localhost → bot on 127.0.0.1). In production the fetch fails fast and the
 * panel shows "offline".
 */
export type BotMode = 'record' | 'dry' | 'live'

export interface BotStatus {
  mode: BotMode
  /** Optional so a bot predating the swing strategy still renders (defaults to value). */
  strategy?: 'value' | 'swing'
  allowLive: boolean
  halted: boolean
  connected: boolean
  scopes: string[]
  liveScopes: number
  stats: { ticks: number; predictions: number; outcomes: number; trades: number; settled: number }
  summary: { entered: number; settled: number; open: number; wins: number; staked: number; pnl: number }
  swingExits?: { reason: string; n: number; wins: number; pnl: number }[]
  swingTrigger?: 'edge' | 'move'
  swingSource?: 'flat' | 'regime' | 'blend'
  openPositions?: {
    coin: string
    timeframe: string
    side: 'up' | 'down'
    strategy: string
    entryPrice: number
    size: number
    mark: number | null
    unrealizedPnl: number | null
    msRemaining: number | null
  }[]
  recentClosed?: {
    coin: string
    timeframe: string
    side: 'up' | 'down'
    strategy: string
    entryPrice: number
    exitPrice: number | null
    exitReason: string | null
    pnl: number
    settleT: number
    status: string
  }[]
}

const BASE =
  ((import.meta.env.VITE_BOT_CONTROL_URL as string | undefined) ?? 'http://127.0.0.1:8790').replace(
    /\/$/,
    '',
  )

/** Token from localStorage (operator-entered) or build-time env. */
function token(): string | null {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('bot-control-token') : null
  return stored || (import.meta.env.VITE_BOT_CONTROL_TOKEN as string | undefined) || null
}

function postHeaders(): Record<string, string> {
  const t = token()
  return { 'content-type': 'application/json', ...(t ? { 'x-bot-token': t } : {}) }
}

export async function fetchBotStatus(): Promise<BotStatus> {
  const res = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2500) })
  if (!res.ok) throw new Error(`bot control ${res.status}`)
  return (await res.json()) as BotStatus
}

async function post(path: string, body: unknown): Promise<BotStatus> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: postHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  const data = (await res.json().catch(() => ({}))) as BotStatus & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `bot control ${res.status}`)
  return data
}

export const setBotMode = (mode: BotMode): Promise<BotStatus> => post('/mode', { mode })
export const setBotHalted = (halted: boolean): Promise<BotStatus> => post('/halt', { halted })
