import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Load .env.local for `vercel dev` — API routes don't always inherit it otherwise. */
function loadLocalEnv(): void {
  if (process.env.VERCEL_ENV === 'production' || process.env.VERCEL_ENV === 'preview') return

  const root = process.cwd()
  for (const name of ['.env.local', '.env']) {
    const file = resolve(root, name)
    if (!existsSync(file)) continue

    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim()
      if (!(key in process.env)) process.env[key] = value
    }
  }
}

loadLocalEnv()
