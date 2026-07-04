/**
 * Offline strategy backtest. Replays the M2 entry logic over the recorder's
 * stored predictions + outcomes, sweeping edge threshold × entry timing, so the
 * params can be tuned on real collected data without waiting for live windows.
 * Hold-to-settle, skip-panic (same as live); confidence 'ok' required.
 * `pnpm bot:backtest`.
 *
 * Scope note: this tunes the STRATEGY (edge/timing/regime rules) using the
 * already-computed model outputs. Tuning the MODEL itself (vol lookback, regime
 * half-lives) needs a tick-level re-simulation — the ticks are stored, so that's
 * a later extension.
 */
import { existsSync } from 'node:fs'
import { loadConfig } from './config'
import { openDb } from './db'

/** How close a stored sample must be to the target entry time to count. */
const NEAR_MS = 15_000
const STAKE = 1

interface Sample {
  ms: number
  modelP: number
  marketP: number
  regime: string | null
  conf: string
  upAsk: number | null
}

/** A window's viable entry at one target time: the swept edge threshold decides
 * whether it actually trades. */
interface Candidate {
  absEdge: number
  side: 'up' | 'down'
  fill: number
  regime: string
  outcome: 'up' | 'down'
}

interface Result {
  trades: number
  wins: number
  staked: number
  pnl: number
  byRegime: Map<string, { trades: number; wins: number; pnl: number }>
}

function parseNums(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback
  const xs = raw.split(',').map(Number).filter((n) => Number.isFinite(n))
  return xs.length ? xs : fallback
}

/** Nearest in-band sample to the target, passing confidence + skip-panic. */
function pickEntry(samples: Sample[], targetMs: number): Sample | null {
  let best: Sample | null = null
  let bestDelta = Infinity
  for (const s of samples) {
    if (s.ms < 2_000) continue
    const delta = Math.abs(s.ms - targetMs)
    if (delta > NEAR_MS) continue
    if (s.conf !== 'ok' || s.regime === 'panic') continue
    if (delta < bestDelta) {
      bestDelta = delta
      best = s
    }
  }
  return best
}

function simulate(candidates: Candidate[], edgeThreshold: number): Result {
  const r: Result = { trades: 0, wins: 0, staked: 0, pnl: 0, byRegime: new Map() }
  for (const c of candidates) {
    if (c.absEdge < edgeThreshold) continue
    const size = STAKE / c.fill
    const won = c.side === c.outcome
    const pnl = won ? size - STAKE : -STAKE
    r.trades += 1
    r.wins += won ? 1 : 0
    r.staked += STAKE
    r.pnl += pnl
    const b = r.byRegime.get(c.regime) ?? { trades: 0, wins: 0, pnl: 0 }
    b.trades += 1
    b.wins += won ? 1 : 0
    b.pnl += pnl
    r.byRegime.set(c.regime, b)
  }
  return r
}

const roi = (r: Result): number => (r.staked > 0 ? (r.pnl / r.staked) * 100 : 0)
const hit = (r: Result): number => (r.trades > 0 ? (r.wins / r.trades) * 100 : 0)
const padL = (s: string, n: number): string => s.padStart(n)
const pad = (s: string, n: number): string => s.padEnd(n)

function main(): void {
  const { dbPath } = loadConfig()
  if (!existsSync(dbPath)) {
    console.log(`No database at ${dbPath} — run \`pnpm bot:record\` first.`)
    return
  }
  const edges = parseNums(process.env.BT_EDGES, [0.02, 0.04, 0.05, 0.06, 0.08, 0.1, 0.15])
  const entriesSec = parseNums(process.env.BT_ENTRIES, [10, 20, 40, 90, 150])
  const minTrades = parseNums(process.env.BT_MIN_TRADES, [5])[0]

  const db = openDb(dbPath, true)
  const outcomes = new Map(
    (db.raw.prepare('SELECT window_key AS w, outcome FROM outcomes').all() as {
      w: string
      outcome: 'up' | 'down'
    }[]).map((o) => [o.w, o.outcome]),
  )
  if (outcomes.size === 0) {
    console.log('No resolved windows yet — let the recorder run through some windows first.')
    db.close()
    return
  }

  const rows = db.raw
    .prepare(
      `SELECT p.window_key AS w, p.ms_remaining AS ms, p.model_p AS modelP, p.market_p AS marketP,
              p.regime AS regime, p.confidence AS conf, p.up_ask AS upAsk
       FROM predictions p JOIN outcomes o ON o.window_key = p.window_key`,
    )
    .all() as (Sample & { w: string })[]
  db.close()

  const byWindow = new Map<string, Sample[]>()
  for (const row of rows) {
    const arr = byWindow.get(row.w) ?? []
    arr.push(row)
    byWindow.set(row.w, arr)
  }

  // Precompute per-entry-timing candidates (edge threshold applied later).
  const candByEntry = new Map<number, Candidate[]>()
  for (const entrySec of entriesSec) {
    const target = entrySec * 1_000
    const cands: Candidate[] = []
    for (const [w, samples] of byWindow) {
      const outcome = outcomes.get(w)
      if (!outcome) continue
      const s = pickEntry(samples, target)
      if (!s) continue
      const edge = s.modelP - s.marketP
      const side: 'up' | 'down' = edge > 0 ? 'up' : 'down'
      const fill = side === 'up' ? (s.upAsk ?? s.marketP) : 1 - s.marketP
      if (!(fill > 0 && fill < 1)) continue
      cands.push({ absEdge: Math.abs(edge), side, fill, regime: s.regime ?? 'normal', outcome })
    }
    candByEntry.set(entrySec, cands)
  }

  console.log('\n══ BACKTEST ═════════════════════════════════════════════════')
  console.log(
    `replay over ${outcomes.size} resolved windows · ${rows.length.toLocaleString()} samples · ` +
      `hold-to-settle · skip-panic · conf=ok · $${STAKE}/trade`,
  )

  // ROI matrix: rows = entry timing, cols = edge threshold.
  console.log('\nROI% (trades) — row: entry timing · col: edge threshold')
  console.log('  ' + pad('', 8) + edges.map((e) => padL(e.toFixed(2), 12)).join(''))
  const combos: { edge: number; entrySec: number; r: Result }[] = []
  for (const entrySec of entriesSec) {
    const cands = candByEntry.get(entrySec)!
    let line = '  ' + pad(`T-${entrySec}s`, 8)
    for (const edge of edges) {
      const r = simulate(cands, edge)
      combos.push({ edge, entrySec, r })
      const cell = r.trades ? `${roi(r) >= 0 ? '+' : ''}${roi(r).toFixed(1)}%(${r.trades})` : '—'
      line += padL(cell, 12)
    }
    console.log(line)
  }

  // Ranked top combos (with enough trades to matter).
  const ranked = combos
    .filter((c) => c.r.trades >= minTrades)
    .sort((a, b) => roi(b.r) - roi(a.r))
  console.log(`\ntop combos by ROI (≥${minTrades} trades)`)
  if (!ranked.length) {
    console.log(`  none reached ${minTrades} trades — collect more data or lower BT_MIN_TRADES`)
  } else {
    for (const c of ranked.slice(0, 6)) {
      console.log(
        `  edge ${c.edge.toFixed(2)} · T-${c.entrySec}s → ${padL(String(c.r.trades), 3)} trades · ` +
          `${hit(c.r).toFixed(0)}% hit · staked $${c.r.staked.toFixed(0)} · ` +
          `pnl ${c.r.pnl >= 0 ? '+' : ''}$${c.r.pnl.toFixed(2)} · ROI ${roi(c.r) >= 0 ? '+' : ''}${roi(c.r).toFixed(1)}%`,
      )
    }
  }

  // Live-default combo, for reference (may not be top).
  const def = combos.find((c) => Math.abs(c.edge - 0.05) < 1e-9 && c.entrySec === 10)
  if (def && def.r.trades) {
    console.log(
      `\nlive default (edge 0.05 · T-10s): ${def.r.trades} trades · ${hit(def.r).toFixed(0)}% hit · ` +
        `ROI ${roi(def.r) >= 0 ? '+' : ''}${roi(def.r).toFixed(1)}%`,
    )
  }

  // Per-regime breakdown of the best combo.
  const best = ranked[0]
  if (best) {
    console.log(`\nbest combo per regime (edge ${best.edge.toFixed(2)} · T-${best.entrySec}s)`)
    for (const name of ['calm', 'normal', 'elevated']) {
      const b = best.r.byRegime.get(name)
      if (!b) continue
      const rroi = b.trades ? (b.pnl / b.trades) * 100 : 0
      console.log(
        `  ${pad(name, 10)} ${padL(String(b.trades), 3)} trades · ${((b.wins / b.trades) * 100).toFixed(0)}% hit · ` +
          `pnl ${b.pnl >= 0 ? '+' : ''}$${b.pnl.toFixed(2)} · ROI ${rroi >= 0 ? '+' : ''}${rroi.toFixed(1)}%`,
      )
    }
  }
  console.log('═════════════════════════════════════════════════════════════\n')
}

main()
