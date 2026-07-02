import { getCoin } from './config'
import type { CoinId, ParsedMarket } from './types'

/** RTDS Chainlink symbols — all six coins stream on `crypto_prices_chainlink` (verified 2026-07). */
export const CHAINLINK_PAIR: Partial<Record<CoinId, string>> = {
  btc: 'btc/usd',
  eth: 'eth/usd',
  sol: 'sol/usd',
  xrp: 'xrp/usd',
  doge: 'doge/usd',
  bnb: 'bnb/usd',
}

export function chainlinkPair(coin: CoinId): string | null {
  return CHAINLINK_PAIR[coin] ?? null
}

export interface CryptoPriceSnapshot {
  openPrice: number
  closePrice: number
  timestamp: number
  completed: boolean
  incomplete: boolean
}

function parsePrice(value: unknown): number {
  if (value == null || value === '') return NaN
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
}

/** Rolling slugs (5m/15m/4h) — use slug-anchored eventStartTime when fetching window prices. */
export function isRollingSlug(eventSlug: string): boolean {
  return /-updown-(5m|15m|4h)-\d{10}$/.test(eventSlug)
}

/** Prior adjacent window — its closePrice equals this window's Chainlink open. */
export function previousWindowParams(
  market: ParsedMarket,
): { eventStartTime: string; endDate: string } | null {
  if (!market.startDate || !market.endDate) return null
  const startMs = market.startDate.getTime()
  const durationMs = market.endDate.getTime() - startMs
  if (durationMs <= 0) return null
  return {
    eventStartTime: new Date(startMs - durationMs).toISOString(),
    endDate: new Date(startMs).toISOString(),
  }
}

/** Params for Polymarket's Chainlink window API — one row per market window. */
export function cryptoPriceWindowParams(
  market: ParsedMarket,
): { eventStartTime: string; endDate: string } | null {
  if (!market.endDate) return null

  // Rolling slugs embed the window start as unix seconds — most reliable anchor.
  const slugMatch = market.eventSlug.match(/-(\d{10})$/)
  const eventStartTime = slugMatch
    ? new Date(Number(slugMatch[1]) * 1000).toISOString()
    : market.startDate?.toISOString()
  if (!eventStartTime) return null

  return { eventStartTime, endDate: market.endDate.toISOString() }
}

export async function fetchCryptoPrice(
  symbol: string,
  eventStartTime: string,
  endDate?: string,
): Promise<CryptoPriceSnapshot> {
  const params = new URLSearchParams({ symbol, eventStartTime })
  if (endDate) params.set('endDate', endDate)

  const res = await fetch(`/api/crypto-price?${params}`)
  const body = await res.text()
  let data: CryptoPriceSnapshot & { error?: string }
  try {
    data = JSON.parse(body) as CryptoPriceSnapshot & { error?: string }
  } catch {
    throw new Error(body.trim() || `Crypto price failed (${res.status})`)
  }
  if (!res.ok) throw new Error(data.error ?? (body.trim() || `Crypto price failed (${res.status})`))

  return {
    openPrice: parsePrice(data.openPrice),
    closePrice: parsePrice(data.closePrice),
    timestamp: Number(data.timestamp),
    completed: Boolean(data.completed),
    incomplete: Boolean(data.incomplete),
  }
}

/** USD formatting aligned with Polymarket's Chainlink display. */
export function formatSpotUsd(coin: CoinId, value: number): string {
  const maxFrac = coin === 'xrp' ? 4 : coin === 'doge' ? 5 : 2
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: maxFrac,
  })
}

export function formatSpotDelta(coin: CoinId, delta: number): string {
  const sign = delta >= 0 ? '+' : '−'
  const abs = Math.abs(delta)
  const maxFrac = coin === 'xrp' ? 4 : coin === 'doge' ? 5 : 2
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: maxFrac })}`
}

export function coinSymbol(coin: CoinId): string {
  return getCoin(coin).symbol
}
