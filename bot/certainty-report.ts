/**
 * Easy/certainty trade analysis — groups settled rows by the config snapshot stored
 * at entry time. `pnpm bot:certainty-report`
 */
import { existsSync } from 'node:fs'
import { loadConfig } from './config'
import { openDb } from './db'
import { formatCertaintyConfig } from './engine/certainty'

interface Row {
  cfgEntryWithinSec: number
  cfgMinWinProb: number
  cfgMinEdge: number
  cfgMaxAsk: number
  cfgMinZ: number
  cfgMaxCoins: number
  cfgSignalSource: string
  n: number
  wins: number
  pnl: number
  staked: number
}

function main(): void {
  const { dbPath } = loadConfig()
  if (!existsSync(dbPath)) {
    console.log(`No database at ${dbPath}`)
    return
  }
  const db = openDb(dbPath, true)
  const hasCols = (db.raw.prepare('PRAGMA table_info(trades)').all() as { name: string }[]).some(
    (c) => c.name === 'cfg_entry_within_sec',
  )
  if (!hasCols) {
    console.log('Run the bot once on this build to migrate the trades table, then enter new Easy trades.')
    db.close()
    return
  }

  const rows = db.raw
    .prepare(
      `SELECT cfg_entry_within_sec AS cfgEntryWithinSec, cfg_min_win_prob AS cfgMinWinProb,
              cfg_min_edge AS cfgMinEdge, cfg_max_ask AS cfgMaxAsk, cfg_min_z AS cfgMinZ,
              cfg_max_coins AS cfgMaxCoins, cfg_signal_source AS cfgSignalSource,
              COUNT(*) AS n,
              SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
              COALESCE(SUM(pnl), 0) AS pnl,
              COALESCE(SUM(cost), 0) AS staked
       FROM trades
       WHERE strategy = 'certainty' AND status IN ('settled','closed')
         AND cfg_entry_within_sec IS NOT NULL
       GROUP BY cfg_entry_within_sec, cfg_min_win_prob, cfg_min_edge, cfg_max_ask,
                cfg_min_z, cfg_max_coins, cfg_signal_source
       ORDER BY n DESC`,
    )
    .all() as Row[]

  db.close()

  console.log('\n══ EASY TRADES BY CONFIG (stored at entry) ═══════════════════')
  if (!rows.length) {
    console.log('No certainty trades with config snapshots yet — new entries will be tagged.')
    return
  }

  for (const r of rows) {
    const cfg = formatCertaintyConfig({
      entryWithinSec: r.cfgEntryWithinSec,
      minWinProb: r.cfgMinWinProb,
      minEdge: r.cfgMinEdge,
      maxAsk: r.cfgMaxAsk,
      minZ: r.cfgMinZ,
      maxCoins: r.cfgMaxCoins,
      signalSource: r.cfgSignalSource,
    })
    const hit = r.n > 0 ? (r.wins / r.n) * 100 : 0
    const roi = r.staked > 0 ? (r.pnl / r.staked) * 100 : 0
    console.log(
      `\n${cfg}\n  z≥${r.cfgMinZ} · src ${r.cfgSignalSource} · ${r.n} trades · ` +
        `${hit.toFixed(0)}% hit · pnl ${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(2)} · ROI ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`,
    )
  }
}

main()
