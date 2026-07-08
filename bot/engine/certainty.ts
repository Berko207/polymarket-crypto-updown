/**
 * Late-window certainty — scan all coins near T-30, bet the oracle-favored side
 * when model P(win) is high AND the ask still underprices it (edge = pWin − ask).
 * Auto-sell at ≥99¢ when the bid is there; after the window, sell or redeem to free USDC.
 */
import type { BotConfig } from '../config'
import type { Prediction } from './predict'
import type { Order } from './strategy'
import { askForSide, deriveBook, sourceProb } from './swing'
import { winProbForSide } from './valueExit'
import type { ParsedMarket } from '../../src/lib/types'

export interface CertaintyEval {
  side: 'up' | 'down'
  pWin: number
  zDist: number
  ask: number
  edge: number
  score: number
  ok: boolean
  reason?: string
}

export interface CertaintyCandidate {
  pred: Prediction
  market: ParsedMarket
  eval: CertaintyEval
}

/** Config knobs active when an Easy entry fired — stored on the trade row for analysis. */
export interface CertaintyConfigSnapshot {
  entryWithinSec: number
  minWinProb: number
  minEdge: number
  maxAsk: number
  minZ: number
  maxCoins: number
  signalSource: string
}

/** Entry-time metrics + config snapshot for `trades` persistence. */
export interface CertaintyEntryRecord extends CertaintyConfigSnapshot {
  entryPWin: number
  entryZ: number
  entryMsRemaining: number
}

export function certaintyConfigSnapshot(config: BotConfig): CertaintyConfigSnapshot {
  return {
    entryWithinSec: config.certaintyEntryWithinSec,
    minWinProb: config.certaintyMinWinProb,
    minEdge: config.certaintyMinEdge,
    maxAsk: config.certaintyMaxAsk,
    minZ: config.certaintyMinZ,
    maxCoins: config.certaintyMaxCoins,
    signalSource: config.signalSource,
  }
}

export function certaintyEntryRecord(
  ev: CertaintyEval,
  pred: Prediction,
  config: BotConfig,
): CertaintyEntryRecord {
  return {
    ...certaintyConfigSnapshot(config),
    entryPWin: ev.pWin,
    entryZ: ev.zDist,
    entryMsRemaining: pred.msRemaining,
  }
}

/** Human-readable config line (matches dashboard badge style). */
export function formatCertaintyConfig(c: CertaintyConfigSnapshot): string {
  return (
    `T-${c.entryWithinSec}s · P≥${(c.minWinProb * 100).toFixed(0)}% · ` +
    `edge≥${(c.minEdge * 100).toFixed(0)}¢ · ask≤${(c.maxAsk * 100).toFixed(0)}¢ · max ${c.maxCoins}`
  )
}

/** Oracle-favored side at the current spot vs strike. */
export function oracleFavoredSide(spot: number, strike: number): 'up' | 'down' {
  return spot >= strike ? 'up' : 'down'
}

/**
 * Strike for Easy entries — Polymarket's published priceToBeat when available
 * (same source they resolve against), else the Chainlink window open.
 */
export function certaintyStrike(
  market: Pick<ParsedMarket, 'priceToBeat'>,
  chainlinkOpen: number | null,
): number | null {
  const ptb = market.priceToBeat
  if (ptb != null && ptb > 0) return ptb
  return chainlinkOpen
}

/** σ-distance of spot from strike over remaining window vol. */
function zDistance(spot: number, strike: number, sigmaWindow: number): number {
  if (!(sigmaWindow > 0)) return 0
  return Math.abs(Math.log(spot / strike)) / sigmaWindow
}

/** Rank key — favors underpriced locks with high model certainty. */
function certaintyScore(pWin: number, edge: number, zDist: number): number {
  return edge * 2 + (pWin - 0.5) + Math.min(zDist / 4, 0.25)
}

export function inCertaintyEntryBand(msRemaining: number, config: BotConfig): boolean {
  return (
    msRemaining <= config.certaintyEntryWithinSec * 1_000 &&
    msRemaining >= config.certaintyMinMsRemaining
  )
}

export interface CertaintyEvalOpts {
  /** When set (live), gates use this ask only — no gamma complement fallback. */
  clobAsk?: number | null
  /** Opposite side's CLOB ask — favored ask must exceed this when both are known. */
  clobOppAsk?: number | null
  /** Live: reject when no real CLOB ask was fetched for the favored token. */
  requireClobAsk?: boolean
}

/** Score a scope; `ok` when every hard gate passes. */
export function evaluateCertainty(
  pred: Prediction,
  market: ParsedMarket,
  spot: number,
  strike: number,
  config: BotConfig,
  now: number,
  opts?: CertaintyEvalOpts,
): CertaintyEval {
  const msRemaining = market.endDate.getTime() - now
  const side = oracleFavoredSide(spot, strike)
  const pWin = winProbForSide(pred, side, config)
  const zDist = zDistance(spot, strike, pred.sigmaWindow)
  const gammaAsk = (): number => {
    const book = deriveBook(market)
    const askRaw = askForSide(book, side)
    return (
      askRaw ??
      (side === 'up'
        ? Number.isFinite(market.upPrice)
          ? market.upPrice
          : pred.marketP
        : 1 - pred.marketP)
    )
  }
  let ask: number
  const useClob = opts && 'clobAsk' in opts
  if (useClob && opts.clobAsk != null && opts.clobAsk > 0 && opts.clobAsk < 1) {
    ask = opts.clobAsk
  } else if (useClob && opts.requireClobAsk) {
    ask = NaN
  } else if (useClob) {
    ask = gammaAsk()
  } else {
    ask = gammaAsk()
  }
  const edge = pWin - ask
  const score = certaintyScore(pWin, edge, zDist)

  const fail = (reason: string): CertaintyEval => ({
    side,
    pWin,
    zDist,
    ask,
    edge,
    score,
    ok: false,
    reason,
  })

  if (!inCertaintyEntryBand(msRemaining, config)) {
    return fail(`outside T-${config.certaintyEntryWithinSec}s band`)
  }
  const clobTrusted =
    useClob &&
    opts.requireClobAsk === true &&
    opts.clobAsk != null &&
    opts.clobAsk > 0 &&
    opts.clobAsk < 1
  // Gamma Up spread can read wide while the favored CLOB token has a real ask.
  if (!clobTrusted && pred.confidence !== 'ok') return fail(`confidence ${pred.confidence}`)
  if (pred.regime === 'panic') return fail('regime panic')
  if (pWin < config.certaintyMinWinProb) {
    return fail(`P(win) ${pWin.toFixed(3)} < ${config.certaintyMinWinProb}`)
  }
  if (config.certaintyMinZ > 0 && zDist < config.certaintyMinZ) {
    return fail(`z ${zDist.toFixed(2)} < ${config.certaintyMinZ}`)
  }
  if (!(ask > 0 && ask < 1)) {
    return fail(useClob && opts?.requireClobAsk ? 'no CLOB ask' : useClob ? 'no CLOB ask' : `no ask for ${side}`)
  }
  if (ask > config.certaintyMaxAsk) {
    return fail(`ask ${ask.toFixed(3)} > max ${config.certaintyMaxAsk}`)
  }
  if (ask < config.certaintyMinFavoredAsk) {
    return fail(
      `favored ask ${ask.toFixed(3)} < min ${config.certaintyMinFavoredAsk} (market disagrees with oracle)`,
    )
  }
  if (edge > config.certaintyMaxEdge) {
    return fail(`edge ${edge.toFixed(3)} > max ${config.certaintyMaxEdge} (likely strike/book mismatch)`)
  }
  const oppAsk = opts?.clobOppAsk
  if (oppAsk != null && oppAsk > 0 && oppAsk < 1 && ask <= oppAsk) {
    return fail(`favored ask ${ask.toFixed(3)} ≤ opposite ${oppAsk.toFixed(3)}`)
  }
  if (edge < config.certaintyMinEdge) {
    return fail(`edge ${edge.toFixed(3)} < ${config.certaintyMinEdge}`)
  }
  const tokenId = side === 'up' ? market.upTokenId : market.downTokenId
  if (!tokenId) return fail(`missing ${side} tokenId`)

  return { side, pWin, zDist, ask, edge, score, ok: true }
}

/** Why entry is blocked when in the late band (for skip logs). */
export function certaintyBlockReason(
  pred: Prediction,
  market: ParsedMarket,
  spot: number,
  strike: number,
  config: BotConfig,
  now: number,
  opts?: CertaintyEvalOpts,
): string | null {
  const msRemaining = market.endDate.getTime() - now
  if (!inCertaintyEntryBand(msRemaining, config)) return null
  const ev = evaluateCertainty(pred, market, spot, strike, config, now, opts)
  return ev.ok ? null : (ev.reason ?? null)
}

export function rankCertaintyCandidates(candidates: CertaintyCandidate[]): CertaintyCandidate[] {
  return [...candidates].sort((a, b) => b.eval.score - a.eval.score)
}

export function pickCertaintyCandidates(
  candidates: CertaintyCandidate[],
  config: BotConfig,
): CertaintyCandidate[] {
  const ranked = rankCertaintyCandidates(candidates)
  if (ranked.length < config.certaintyMinCoins) return []
  return ranked.slice(0, config.certaintyMaxCoins)
}

export function orderFromCertainty(
  candidate: CertaintyCandidate,
  config: BotConfig,
): Order {
  const { side, ask } = candidate.eval
  const market = candidate.market
  return {
    side,
    stakeUsd: config.stakeUsd,
    fillPrice: ask,
    tokenId: (side === 'up' ? market.upTokenId : market.downTokenId)!,
    tickSize: market.tickSize,
    negRisk: market.negRisk,
  }
}

/** P(Up) from the configured source — exposed for status/logging. */
export function certaintySourceP(pred: Prediction, config: BotConfig): number {
  return sourceProb(pred, config.signalSource)
}
