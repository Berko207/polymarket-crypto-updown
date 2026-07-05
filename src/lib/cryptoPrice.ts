import { getCoin } from './config'
import type { CoinId, ParsedMarket } from './types'

/** RTDS Chainlink symbols (doge/bnb verified streaming — probe RTDS before removing). */
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

/** Usable price or null. Both strike consumers (focused card + watchlist lean) must
 * share this — if they validate differently they can disagree on the same snapshot. */
export function validPrice(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Rolling slugs (5m/15m/4h) — use slug-anchored eventStartTime when fetching window prices. */
export function isRollingSlug(eventSlug: string): boolean {
  return /-updown-(5m|15m|4h)-\d{10}$/.test(eventSlug)
}

/**
 * Upstream window discriminator (names lifted from polymarket.com's own event pages).
 * Without it the crypto-price API ignores endDate: openPrice anchors to the hour and
 * closePrice is just the live print — poison for per-slot strikes.
 */
const CRYPTO_PRICE_VARIANT: Partial<Record<ParsedMarket['timeframe'], string>> = {
  '5m': 'fiveminute',
  '15m': 'fifteen',
  '4h': 'fourhour',
}

/**
 * Max ms after a window boundary that a Chainlink tick may be accepted as the
 * settlement/resolution price. Shared by the settlement path in `useMarketSpot`
 * and the outcome backfill in `useFairValue` so both resolve to the SAME price —
 * a >60s gap is never a near-tie, so the up/down sign is unambiguous. Tighter than
 * the 120s rolling-strike slop, which only needs the window's open value, not a
 * knife-edge resolution.
 */
export const SETTLE_SLOP_MS = 60_000

export interface CryptoPriceWindowParams {
  eventStartTime: string
  endDate: string
  variant?: string
}

/** Prior adjacent window — its closePrice equals this window's Chainlink open. */
export function previousWindowParams(market: ParsedMarket): CryptoPriceWindowParams | null {
  if (!market.startDate || !market.endDate) return null
  const startMs = market.startDate.getTime()
  const durationMs = market.endDate.getTime() - startMs
  if (durationMs <= 0) return null
  return {
    eventStartTime: new Date(startMs - durationMs).toISOString(),
    endDate: new Date(startMs).toISOString(),
    variant: windowVariant(market),
  }
}

/** Upstream discriminator: daily windows share their noon-ET start with hourly
 * markets — without `variant=daily` the API returns the wrong closed hourly row. */
export type CryptoPriceVariant = 'daily'

export function cryptoPriceVariant(market: ParsedMarket): CryptoPriceVariant | undefined {
  return market.timeframe === 'daily' ? 'daily' : undefined
}

function windowVariant(market: ParsedMarket): string | undefined {
  return cryptoPriceVariant(market) ?? CRYPTO_PRICE_VARIANT[market.timeframe]
}

/** Params for Polymarket's Chainlink window API — one row per market window. */
export function cryptoPriceWindowParams(market: ParsedMarket): CryptoPriceWindowParams | null {
  if (!market.endDate) return null

  // Rolling slugs embed the window start as unix seconds — most reliable anchor.
  const slugMatch = market.eventSlug.match(/-(\d{10})$/)
  const eventStartTime = slugMatch
    ? new Date(Number(slugMatch[1]) * 1000).toISOString()
    : market.startDate?.toISOString()
  if (!eventStartTime) return null

  return {
    eventStartTime,
    endDate: market.endDate.toISOString(),
    variant: windowVariant(market),
  }
}

export async function fetchCryptoPrice(
  symbol: string,
  eventStartTime: string,
  endDate?: string,
  variant?: string,
): Promise<CryptoPriceSnapshot> {
  const params = new URLSearchParams({ symbol, eventStartTime })
  if (endDate) params.set('endDate', endDate)
  if (variant) params.set('variant', variant)

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

export interface CryptoPricePoint {
  timestamp: number
  value: number
}

/** Chainlink path for a window, from its open — 1-min fidelity (5-min for daily). */
export async function fetchCryptoPriceHistory(
  symbol: string,
  eventStartTime: string,
  variant?: string,
): Promise<CryptoPricePoint[]> {
  const params = new URLSearchParams({ symbol, eventStartTime })
  if (variant) params.set('variant', variant)

  const res = await fetch(`/api/crypto-price-history?${params}`)
  if (!res.ok) throw new Error(`Price history failed (${res.status})`)
  const data = (await res.json()) as CryptoPricePoint[]
  if (!Array.isArray(data)) throw new Error('Price history: unexpected response')
  return data.filter(
    (p) => Number.isFinite(Number(p?.timestamp)) && Number.isFinite(Number(p?.value)) && Number(p.value) > 0,
  )
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
