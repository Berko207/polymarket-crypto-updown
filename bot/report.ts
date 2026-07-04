/**
 * Read-only summary of the recorder's SQLite log: dataset scope, Brier
 * flat/reg/mkt (matched), and the per-regime breakdown — the headless
 * equivalent of the dashboard RegimePanel, but 24/7 across all scopes.
 * `pnpm bot:report`.
 */
import { existsSync } from 'node:fs'
import { loadConfig } from './config'
import { openDb } from './db'

const f = (v: number | null | undefined): string =>
  v == null ? '  —  ' : v.toFixed(3)

const pad = (s: string, n: number): string => s.padEnd(n)
const padL = (s: string, n: number): string => s.padStart(n)

interface BrierAgg {
  n: number
  bm: number | null // flat
  br: number | null // regime
  bk: number | null // market
}

function main(): void {
  const { dbPath } = loadConfig()
  if (!existsSync(dbPath)) {
    console.log(`No database at ${dbPath} — run \`pnpm bot:record\` first.`)
    return
  }
  const db = openDb(dbPath, true)
  const raw = db.raw

  const counts = raw
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM ticks) AS ticks,
         (SELECT COUNT(*) FROM predictions) AS preds,
         (SELECT COUNT(*) FROM outcomes) AS outcomes,
         (SELECT MIN(t) FROM predictions) AS minT,
         (SELECT MAX(t) FROM predictions) AS maxT`,
    )
    .get() as { ticks: number; preds: number; outcomes: number; minT: number | null; maxT: number | null }

  const spanDays = counts.minT && counts.maxT ? (counts.maxT - counts.minT) / 86_400_000 : 0

  // Matched Brier: flat/reg/mkt over samples that carry a regime prediction.
  const matched = raw
    .prepare(
      `SELECT
         COUNT(*) AS n,
         AVG((p.model_p  - (o.outcome='up')) * (p.model_p  - (o.outcome='up'))) AS bm,
         AVG((p.regime_p - (o.outcome='up')) * (p.regime_p - (o.outcome='up'))) AS br,
         AVG((p.market_p - (o.outcome='up')) * (p.market_p - (o.outcome='up'))) AS bk
       FROM predictions p JOIN outcomes o USING(window_key)
       WHERE p.regime_p IS NOT NULL`,
    )
    .get() as BrierAgg

  const byRegime = raw
    .prepare(
      `SELECT p.regime AS regime,
         COUNT(*) AS n,
         AVG((p.model_p  - (o.outcome='up')) * (p.model_p  - (o.outcome='up'))) AS bm,
         AVG((p.regime_p - (o.outcome='up')) * (p.regime_p - (o.outcome='up'))) AS br,
         AVG((p.market_p - (o.outcome='up')) * (p.market_p - (o.outcome='up'))) AS bk
       FROM predictions p JOIN outcomes o USING(window_key)
       WHERE p.regime_p IS NOT NULL
       GROUP BY p.regime`,
    )
    .all() as (BrierAgg & { regime: string })[]

  const byScope = raw
    .prepare(
      `SELECT coin, timeframe, COUNT(*) AS n,
         COUNT(DISTINCT window_key) AS windows
       FROM predictions GROUP BY coin, timeframe ORDER BY coin, timeframe`,
    )
    .all() as { coin: string; timeframe: string; n: number; windows: number }[]

  console.log('\n══ RECORDER REPORT ══════════════════════════════════════════')
  console.log(
    `dataset · ${counts.preds.toLocaleString()} predictions · ${counts.outcomes.toLocaleString()} outcomes · ` +
      `${counts.ticks.toLocaleString()} ticks · ${spanDays.toFixed(1)}d span`,
  )

  console.log('\nmatched Brier (lower wins) — samples with a regime prediction')
  if (!matched.n) {
    console.log('  no scored regime samples yet (need resolved windows)')
  } else {
    const edge = matched.bm != null && matched.br != null ? matched.bm - matched.br : null
    const verdict =
      edge == null
        ? ''
        : Math.abs(edge) < 0.0005
          ? '→ dead heat'
          : edge > 0
            ? `→ regime ahead ${edge.toFixed(3)}`
            : `→ flat ahead ${(-edge).toFixed(3)}`
    console.log(
      `  n=${matched.n}  flat ${f(matched.bm)}  reg ${f(matched.br)}  mkt ${f(matched.bk)}  ${verdict}`,
    )
  }

  console.log('\nper regime')
  console.log(`  ${pad('regime', 10)}${padL('n', 8)}${padL('flat', 9)}${padL('reg', 9)}${padL('mkt', 9)}`)
  const order = ['calm', 'normal', 'elevated', 'panic']
  const map = new Map(byRegime.map((r) => [r.regime, r]))
  for (const name of order) {
    const r = map.get(name)
    if (!r) {
      console.log(`  ${pad(name, 10)}${padL('—', 8)}`)
      continue
    }
    console.log(
      `  ${pad(name, 10)}${padL(String(r.n), 8)}${padL(f(r.bm), 9)}${padL(f(r.br), 9)}${padL(f(r.bk), 9)}`,
    )
  }
  const divergent = (map.get('elevated')?.n ?? 0) + (map.get('panic')?.n ?? 0)
  console.log(
    `  divergent (elevated+panic): ${divergent}${divergent === 0 ? '  — all calm/normal, A/B not yet meaningful' : ''}`,
  )

  console.log('\nper scope')
  for (const s of byScope) {
    console.log(`  ${pad(`${s.coin}/${s.timeframe}`, 12)} ${padL(String(s.n), 7)} samples · ${s.windows} windows`)
  }

  // --- dry paper-trading P&L (M2) ---
  const t = raw
    .prepare(
      `SELECT
         COUNT(*) AS n,
         SUM(CASE WHEN status='settled' THEN 1 ELSE 0 END) AS settled,
         SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN status='settled' AND pnl > 0 THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN status='settled' THEN cost ELSE 0 END) AS staked,
         SUM(CASE WHEN status='settled' THEN pnl ELSE 0 END) AS pnl
       FROM trades WHERE mode='dry'`,
    )
    .get() as {
    n: number
    settled: number
    open: number
    wins: number
    staked: number | null
    pnl: number | null
  }

  console.log('\ndry paper trades')
  if (!t.n) {
    console.log('  none yet — run `pnpm bot:dry`')
  } else {
    const staked = t.staked ?? 0
    const pnl = t.pnl ?? 0
    const hit = t.settled ? ((t.wins / t.settled) * 100).toFixed(0) : '—'
    const roi = staked > 0 ? ((pnl / staked) * 100).toFixed(1) : '—'
    console.log(`  ${t.n} entered · ${t.settled} settled · ${t.open} open`)
    console.log(
      `  wins ${t.wins}/${t.settled} (${hit}% hit) · staked $${staked.toFixed(2)} · ` +
        `pnl ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (ROI ${roi}%)`,
    )
    const byReg = raw
      .prepare(
        `SELECT regime_entry AS regime,
           SUM(CASE WHEN status='settled' THEN 1 ELSE 0 END) AS settled,
           SUM(CASE WHEN status='settled' AND pnl>0 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN status='settled' THEN pnl ELSE 0 END) AS pnl
         FROM trades WHERE mode='dry' GROUP BY regime_entry`,
      )
      .all() as { regime: string | null; settled: number; wins: number; pnl: number | null }[]
    for (const r of byReg.filter((x) => x.settled > 0)) {
      console.log(
        `    ${pad(r.regime ?? '—', 10)} ${r.wins}/${r.settled} win · pnl ${(r.pnl ?? 0) >= 0 ? '+' : ''}${(r.pnl ?? 0).toFixed(2)}`,
      )
    }
  }
  console.log('═════════════════════════════════════════════════════════════\n')

  db.close()
}

main()
