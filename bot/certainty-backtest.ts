/**
 * Certainty-strategy backtest — oracle-side late entries with high P(win) + edge.
 * Replays stored predictions at T-30 (configurable), ranks like live, hold-to-settle.
 * `pnpm bot:certainty-backtest`
 */
import { existsSync } from 'node:fs'
import { loadConfig } from './config'
import { openDb } from './db'

const NEAR_MS = 15_000
const STAKE = 1

interface Sample {
  ms: number
  spot: number
  strike: number
  modelP: number
  regimeP: number | null
  marketP: number
  regime: string | null
  conf: string
  sigmaWindow: number
  upAsk: number | null
}

interface Candidate {
  absScore: number
  side: 'up' | 'down'
  pWin: number
  zDist: number
  fill: number
  edge: number
  outcome: 'up' | 'down'
}

interface Result {
  trades: number
  wins: number
  staked: number
  pnl: number
}

function parseNums(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback
  const xs = raw.split(',').map(Number).filter((n) => Number.isFinite(n))
  return xs.length ? xs : fallback
}

function sourceP(s: Sample): number {
  return s.regimeP ?? s.modelP
}

function pickSample(samples: Sample[], targetMs: number, minMs: number): Sample | null {
  let best: Sample | null = null
  let bestDelta = Infinity
  for (const s of samples) {
    if (s.ms < minMs) continue
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

function zDistance(spot: number, strike: number, sigmaWindow: number): number {
  if (!(sigmaWindow > 0) || !(spot > 0) || !(strike > 0)) return 0
  return Math.abs(Math.log(spot / strike)) / sigmaWindow
}

function simulate(cands: Candidate[]): Result {
  const r: Result = { trades: 0, wins: 0, staked: 0, pnl: 0 }
  for (const c of cands) {
    const size = STAKE / c.fill
    const won = c.side === c.outcome
    const pnl = won ? size - STAKE : -STAKE
    r.trades += 1
    r.wins += won ? 1 : 0
    r.staked += STAKE
    r.pnl += pnl
  }
  return r
}

const roi = (r: Result): number => (r.staked > 0 ? (r.pnl / r.staked) * 100 : 0)
const hit = (r: Result): number => (r.trades > 0 ? (r.wins / r.trades) * 100 : 0)

function main(): void {
  const cfg = loadConfig()
  const entrySec = parseNums(process.env.BT_CERTAINTY_ENTRY_SEC, [30])[0]
  const minMs = cfg.certaintyMinMsRemaining
  const minWinProbs = parseNums(process.env.BT_CERTAINTY_MIN_WIN_PROB, [0.9, 0.93, 0.95, 0.97])
  const minEdges = parseNums(process.env.BT_CERTAINTY_MIN_EDGE, [0.02, 0.03, 0.05])
  const minZs = parseNums(process.env.BT_CERTAINTY_MIN_Z, [0, 1.5, 2, 2.5])
  const maxAsks = parseNums(process.env.BT_CERTAINTY_MAX_ASK, [0.92, 0.95, 0.97])
  const minTrades = parseNums(process.env.BT_MIN_TRADES, [5])[0]

  const { dbPath } = cfg
  if (!existsSync(dbPath)) {
    console.log(`No database at ${dbPath} — run \`pnpm bot:record\` first.`)
    return
  }

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
      `SELECT p.window_key AS w, p.ms_remaining AS ms, p.spot AS spot, p.strike AS strike,
              p.model_p AS modelP, p.regime_p AS regimeP, p.market_p AS marketP,
              p.regime AS regime, p.confidence AS conf, p.sigma_window AS sigmaWindow,
              p.up_ask AS upAsk
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

  const rawCands: Omit<Candidate, 'absScore'>[] = []
  const target = entrySec * 1_000
  for (const [w, samples] of byWindow) {
    const outcome = outcomes.get(w)
    if (!outcome) continue
    const s = pickSample(samples, target, minMs)
    if (!s || !(s.spot > 0) || !(s.strike > 0)) continue
    const side: 'up' | 'down' = s.spot >= s.strike ? 'up' : 'down'
    const pUp = sourceP(s)
    const pWin = side === 'up' ? pUp : 1 - pUp
    const zDist = zDistance(s.spot, s.strike, s.sigmaWindow)
    const fill =
      side === 'up'
        ? (s.upAsk ?? s.marketP)
        : 1 - (s.upAsk ?? s.marketP)
    if (!(fill > 0 && fill < 1)) continue
    const edge = pWin - fill
    rawCands.push({ side, pWin, zDist, fill, edge, outcome })
  }

  console.log('\n══ CERTAINTY BACKTEST ═══════════════════════════════════════')
  console.log(
    `T-${entrySec}s oracle-side · ${outcomes.size} windows · ${rawCands.length} in-band samples · ` +
      `hold-to-settle · skip-panic · conf=ok · $${STAKE}/trade`,
  )

  type Combo = { minP: number; minEdge: number; minZ: number; maxAsk: number; r: Result }
  const combos: Combo[] = []

  for (const minP of minWinProbs) {
    for (const minEdge of minEdges) {
      for (const minZ of minZs) {
        for (const maxAsk of maxAsks) {
          const filtered: Candidate[] = []
          for (const c of rawCands) {
            if (c.pWin < minP) continue
            if (c.edge < minEdge) continue
            if (minZ > 0 && c.zDist < minZ) continue
            if (c.fill > maxAsk) continue
            filtered.push({
              ...c,
              absScore: c.edge * 2 + (c.pWin - 0.5) + Math.min(c.zDist / 4, 0.25),
            })
          }
          filtered.sort((a, b) => b.absScore - a.absScore)
          combos.push({ minP, minEdge, minZ, maxAsk, r: simulate(filtered) })
        }
      }
    }
  }

  const ranked = combos.filter((c) => c.r.trades >= minTrades).sort((a, b) => roi(b.r) - roi(a.r))
  console.log(`\ntop combos by ROI (≥${minTrades} trades)`)
  if (!ranked.length) {
    console.log(`  none reached ${minTrades} trades — collect more data or lower BT_MIN_TRADES`)
  } else {
    for (const c of ranked.slice(0, 8)) {
      console.log(
        `  P≥${c.minP.toFixed(2)} edge≥${c.minEdge.toFixed(2)} z≥${c.minZ} ask≤${c.maxAsk.toFixed(2)} → ` +
          `${c.r.trades} trades · ${hit(c.r).toFixed(0)}% hit · pnl ${c.r.pnl >= 0 ? '+' : ''}$${c.r.pnl.toFixed(2)} · ` +
          `ROI ${roi(c.r) >= 0 ? '+' : ''}${roi(c.r).toFixed(1)}%`,
      )
    }
  }

  const live = combos.find(
    (c) =>
      Math.abs(c.minP - cfg.certaintyMinWinProb) < 1e-9 &&
      Math.abs(c.minEdge - cfg.certaintyMinEdge) < 1e-9 &&
      c.minZ === cfg.certaintyMinZ &&
      Math.abs(c.maxAsk - cfg.certaintyMaxAsk) < 1e-9,
  )
  if (live && live.r.trades) {
    console.log(
      `\nlive defaults (P≥${cfg.certaintyMinWinProb} edge≥${cfg.certaintyMinEdge} z≥${cfg.certaintyMinZ} ask≤${cfg.certaintyMaxAsk}): ` +
        `${live.r.trades} trades · ${hit(live.r).toFixed(0)}% hit · ROI ${roi(live.r) >= 0 ? '+' : ''}${roi(live.r).toFixed(1)}%`,
    )
  }
}

main()
