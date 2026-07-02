/**
 * Prediction log — IndexedDB persistence for model-vs-market samples and window
 * outcomes. Every prediction the fair-value model makes is recorded against
 * what actually happened, so calibration (Brier: model vs. market) is checkable
 * instead of vibes. Local-only; survives reloads, capped by age and count.
 */

import type { CoinId, TimeframeId } from './types'
import type { FairValueConfidence } from './fairValue'

const DB_NAME = 'pm-prediction-log'
const DB_VERSION = 1
const SAMPLES = 'samples'
const OUTCOMES = 'outcomes'
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const MAX_SAMPLES = 100_000

export interface PredictionSample {
  windowKey: string
  eventSlug: string
  coin: CoinId
  timeframe: TimeframeId
  /** Sample wall-clock ms. */
  t: number
  msRemaining: number
  spot: number
  strike: number
  /** Model P(Up). */
  modelP: number
  /** Order-book P(Up) (mid). */
  marketP: number
  upBid: number | null
  upAsk: number | null
  /** σ over the remaining window (log-return units). */
  sigmaWindow: number
  confidence: FairValueConfidence
}

export interface WindowOutcome {
  windowKey: string
  eventSlug: string
  coin: CoinId
  timeframe: TimeframeId
  strike: number
  finalPrice: number
  outcome: 'up' | 'down'
  endMs: number
  recordedAt: number
}

export interface CalibrationStats {
  /** Outcomes recorded. */
  windows: number
  /** Outcomes with at least one sample to score. */
  scoredWindows: number
  /** Samples scored (sample-weighted Brier — long windows weigh more). */
  samples: number
  brierModel: number | null
  brierMarket: number | null
}

let dbPromise: Promise<IDBDatabase> | null = null
let pruned = false

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(SAMPLES)) {
        const store = db.createObjectStore(SAMPLES, { keyPath: 'id', autoIncrement: true })
        store.createIndex('t', 't')
        store.createIndex('windowKey', 'windowKey')
      }
      if (!db.objectStoreNames.contains(OUTCOMES)) {
        const store = db.createObjectStore(OUTCOMES, { keyPath: 'windowKey' })
        store.createIndex('endMs', 'endMs')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
  return dbPromise
}

function getAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result as T[])
    req.onerror = () => reject(req.error ?? new Error('IndexedDB getAll failed'))
  })
}

export function logSample(sample: PredictionSample): void {
  void openDb()
    .then(async (db) => {
      await prune(db)
      db.transaction(SAMPLES, 'readwrite').objectStore(SAMPLES).add(sample)
    })
    .catch(() => {})
}

export function logOutcome(outcome: WindowOutcome): void {
  void openDb()
    .then((db) => {
      db.transaction(OUTCOMES, 'readwrite').objectStore(OUTCOMES).put(outcome)
    })
    .catch(() => {})
}

async function prune(db: IDBDatabase): Promise<void> {
  if (pruned) return
  pruned = true
  const cutoff = Date.now() - MAX_AGE_MS

  await new Promise<void>((resolve) => {
    const tx = db.transaction([SAMPLES, OUTCOMES], 'readwrite')
    const samples = tx.objectStore(SAMPLES)

    // Age prune both stores.
    const byTime = samples.index('t').openCursor(IDBKeyRange.upperBound(cutoff))
    byTime.onsuccess = () => {
      const cursor = byTime.result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      }
    }
    const byEnd = tx.objectStore(OUTCOMES).index('endMs').openCursor(IDBKeyRange.upperBound(cutoff))
    byEnd.onsuccess = () => {
      const cursor = byEnd.result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      }
    }

    // Count cap: drop oldest samples beyond MAX_SAMPLES.
    const countReq = samples.count()
    countReq.onsuccess = () => {
      let excess = countReq.result - MAX_SAMPLES
      if (excess <= 0) return
      const oldest = samples.index('t').openCursor()
      oldest.onsuccess = () => {
        const cursor = oldest.result
        if (cursor && excess > 0) {
          excess -= 1
          cursor.delete()
          cursor.continue()
        }
      }
    }

    tx.oncomplete = () => resolve()
    tx.onabort = () => resolve()
    tx.onerror = () => resolve()
  })
}

/** Sample-weighted Brier scores across every logged window with an outcome. */
export async function getCalibration(): Promise<CalibrationStats> {
  const empty: CalibrationStats = {
    windows: 0,
    scoredWindows: 0,
    samples: 0,
    brierModel: null,
    brierMarket: null,
  }

  let db: IDBDatabase
  try {
    db = await openDb()
  } catch {
    return empty
  }

  const [outcomes, samples] = await Promise.all([
    getAll<WindowOutcome>(db, OUTCOMES),
    getAll<PredictionSample>(db, SAMPLES),
  ])
  if (outcomes.length === 0) return empty

  const outcomeByWindow = new Map(outcomes.map((o) => [o.windowKey, o]))
  const scored = new Set<string>()
  let n = 0
  let sumModel = 0
  let sumMarket = 0

  for (const s of samples) {
    const outcome = outcomeByWindow.get(s.windowKey)
    if (!outcome) continue
    const y = outcome.outcome === 'up' ? 1 : 0
    sumModel += (s.modelP - y) ** 2
    sumMarket += (s.marketP - y) ** 2
    n += 1
    scored.add(s.windowKey)
  }

  return {
    windows: outcomes.length,
    scoredWindows: scored.size,
    samples: n,
    brierModel: n > 0 ? sumModel / n : null,
    brierMarket: n > 0 ? sumMarket / n : null,
  }
}

/** Full dump (samples + outcomes) for offline analysis. */
export async function exportPredictionLog(): Promise<string> {
  const db = await openDb()
  const [outcomes, samples] = await Promise.all([
    getAll<WindowOutcome>(db, OUTCOMES),
    getAll<PredictionSample>(db, SAMPLES),
  ])
  return JSON.stringify({ exportedAt: new Date().toISOString(), outcomes, samples })
}
