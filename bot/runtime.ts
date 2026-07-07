/** Dashboard-adjusted settings persisted beside the bot (survives restarts). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface RuntimeSettings {
  maxDailyTrades?: number
  /** Dashboard-tuned certainty knobs — survives bot restarts. */
  certainty?: {
    entryWithinSec?: number
    minWinProb?: number
    minEdge?: number
    maxAsk?: number
    maxCoins?: number
  }
}

export function loadRuntimeSettings(path: string): RuntimeSettings {
  try {
    if (!existsSync(path)) return {}
    const raw = readFileSync(path, 'utf8').trim()
    if (!raw) return {}
    return JSON.parse(raw) as RuntimeSettings
  } catch {
    return {}
  }
}

export function saveRuntimeSettings(path: string, patch: RuntimeSettings): void {
  const next = { ...loadRuntimeSettings(path), ...patch }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}
