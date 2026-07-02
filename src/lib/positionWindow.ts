import { CHAINLINK_PAIR, isRollingSlug } from './cryptoPrice'
import { getCoin } from './config'
import { timeframeFromEventSlug, windowEndFromEventSlug } from './slugs'
import type { CoinId, TimeframeId } from './types'

const SLUG_COIN: Record<string, CoinId> = {
  btc: 'btc',
  bitcoin: 'btc',
  eth: 'eth',
  ethereum: 'eth',
  sol: 'sol',
  solana: 'sol',
  xrp: 'xrp',
  doge: 'doge',
  dogecoin: 'doge',
  bnb: 'bnb',
}

const TIMEFRAME_MS: Record<TimeframeId, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  daily: 24 * 60 * 60_000,
}

export interface PositionWindow {
  coin: CoinId
  /** Uppercase ticker for the crypto-price API. */
  symbol: string
  /** RTDS Chainlink pair, when the coin has a stream. */
  pair: string | null
  startMs: number
  endMs: number
  rolling: boolean
}

/**
 * Measurement window for a position, reconstructed from its event slug alone —
 * settling positions have no ParsedMarket to lean on. Returns null for foreign
 * slug conventions (positions bought outside the app).
 */
export function positionWindow(eventSlug: string): PositionWindow | null {
  const end = windowEndFromEventSlug(eventSlug)
  if (!end) return null

  const coinToken = eventSlug.toLowerCase().match(/^([a-z]+)-/)?.[1]
  const coin = coinToken ? SLUG_COIN[coinToken] : undefined
  if (!coin) return null

  const rolling = isRollingSlug(eventSlug)
  let startMs: number
  if (rolling) {
    // Rolling slugs embed the window start as unix seconds.
    const ts = eventSlug.match(/-(\d{10})$/)
    if (!ts) return null
    startMs = Number(ts[1]) * 1000
  } else {
    const timeframe = timeframeFromEventSlug(eventSlug)
    if (!timeframe) return null
    startMs = end.getTime() - TIMEFRAME_MS[timeframe]
  }

  return {
    coin,
    symbol: getCoin(coin).symbol,
    pair: CHAINLINK_PAIR[coin] ?? null,
    startMs,
    endMs: end.getTime(),
    rolling,
  }
}
