/**
 * Fallback window resolution when the Chainlink tick stream misses the boundary.
 * Uses Polymarket's crypto-price API — same source the dashboard uses in
 * useSettlingMark when the RTDS buffer doesn't cover the window end.
 */
import { getCoin } from '../../src/lib/config'
import { validPrice } from '../../src/lib/cryptoPrice'
import { parseMarketWindowKey } from '../../src/lib/marketScope'
import type { CoinId } from '../../src/lib/types'

const UPSTREAM = 'https://polymarket.com/api/crypto/crypto-price'

const VARIANT: Partial<Record<string, string>> = {
  '5m': 'fiveminute',
  '15m': 'fifteen',
  '4h': 'fourhour',
  daily: 'daily',
}

/** Resolved close + open when Polymarket marks the window completed. */
export async function fetchWindowOutcome(
  coin: CoinId,
  timeframe: string,
  windowKey: string,
): Promise<{ finalPrice: number; strike: number } | null> {
  const parsed = parseMarketWindowKey(windowKey)
  if (!parsed) return null

  const params = new URLSearchParams({
    symbol: getCoin(coin).symbol,
    eventStartTime: new Date(parsed.startMs).toISOString(),
    endDate: new Date(parsed.endMs).toISOString(),
  })
  const variant = timeframe === 'daily' ? 'daily' : VARIANT[timeframe]
  if (variant) params.set('variant', variant)

  try {
    const res = await fetch(`${UPSTREAM}?${params}`)
    if (!res.ok) return null
    const data = (await res.json()) as {
      openPrice?: unknown
      closePrice?: unknown
      completed?: boolean
    }
    if (!data.completed) return null
    const finalPrice = validPrice(data.closePrice)
    const strike = validPrice(data.openPrice)
    if (finalPrice == null || strike == null) return null
    return { finalPrice, strike }
  } catch {
    return null
  }
}
