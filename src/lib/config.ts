import type { CoinConfig, CoinId, TimeframeConfig, TimeframeId } from './types'

export const COINS: CoinConfig[] = [
  { id: 'btc', name: 'Bitcoin', symbol: 'BTC', color: '#f7931a', icon: '₿' },
  { id: 'eth', name: 'Ethereum', symbol: 'ETH', color: '#627eea', icon: 'Ξ' },
  { id: 'sol', name: 'Solana', symbol: 'SOL', color: '#9945ff', icon: '◎' },
  { id: 'xrp', name: 'XRP', symbol: 'XRP', color: '#23292f', icon: '✕' },
  { id: 'doge', name: 'Dogecoin', symbol: 'DOGE', color: '#c2a633', icon: 'Ð' },
  { id: 'bnb', name: 'BNB', symbol: 'BNB', color: '#f3ba2f', icon: '◆' },
]

export const TIMEFRAMES: TimeframeConfig[] = [
  { id: '5m', label: '5 Min', shortLabel: '5m' },
  { id: '15m', label: '15 Min', shortLabel: '15m' },
  { id: '1h', label: '1 Hour', shortLabel: '1h' },
  { id: '4h', label: '4 Hours', shortLabel: '4h' },
  { id: 'daily', label: 'Daily', shortLabel: 'Daily' },
]

/** Maps coin + timeframe → Polymarket series slug (null = not available) */
const SERIES_SLUGS: Record<CoinId, Partial<Record<TimeframeId, string>>> = {
  btc: {
    '5m': 'btc-up-or-down-5m',
    '15m': 'btc-up-or-down-15m',
    '1h': 'btc-up-or-down-hourly',
    '4h': 'btc-up-or-down-4h',
    daily: 'btc-up-or-down-daily',
  },
  eth: {
    '5m': 'eth-up-or-down-5m',
    '15m': 'eth-up-or-down-15m',
    '1h': 'eth-up-or-down-hourly',
    '4h': 'eth-up-or-down-4h',
    daily: 'eth-up-or-down-daily',
  },
  sol: {
    '5m': 'sol-up-or-down-5m',
    '15m': 'sol-up-or-down-15m',
    '4h': 'sol-up-or-down-4h',
    daily: 'solana-up-or-down-daily',
  },
  xrp: {
    '5m': 'xrp-up-or-down-5m',
    '15m': 'xrp-up-or-down-15m',
    '1h': 'xrp-up-or-down-hourly',
    '4h': 'xrp-up-or-down-4h',
    daily: 'xrp-up-or-down-daily',
  },
  doge: {
    '5m': 'doge-up-or-down-5m',
    '15m': 'doge-up-or-down-15m',
    '1h': 'doge-up-or-down-hourly',
    '4h': 'doge-up-or-down-4h',
    daily: 'doge-up-or-down-daily',
  },
  bnb: {
    '5m': 'bnb-up-or-down-5m',
    '15m': 'bnb-up-or-down-15m',
    '1h': 'bnb-up-or-down-hourly',
    '4h': 'bnb-up-or-down-4h',
    daily: 'bnb-up-or-down-daily',
  },
}

export function getSeriesSlug(coin: CoinId, timeframe: TimeframeId): string | null {
  return SERIES_SLUGS[coin]?.[timeframe] ?? null
}

export function getAvailableTimeframes(coin: CoinId): TimeframeId[] {
  const slugs = SERIES_SLUGS[coin]
  if (!slugs) return []
  return TIMEFRAMES.filter((t) => slugs[t.id]).map((t) => t.id)
}

export function getCoin(id: CoinId): CoinConfig {
  return COINS.find((c) => c.id === id) ?? COINS[0]
}

export function getTimeframe(id: TimeframeId): TimeframeConfig {
  return TIMEFRAMES.find((t) => t.id === id) ?? TIMEFRAMES[0]
}
