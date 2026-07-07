/**
 * Direct gamma fetch (no Vercel proxy). Reuses the app's slug candidates and
 * parseMarket verbatim so the bot's market view matches the dashboard's.
 */
import { buildEventSlugCandidates } from '../../src/lib/slugs'
import { parseMarket } from '../../src/lib/polymarket'
import type { CoinId, GammaEvent, ParsedMarket, TimeframeId } from '../../src/lib/types'

const GAMMA = 'https://gamma-api.polymarket.com'

async function fetchForSlug(
  slug: string,
  coin: CoinId,
  timeframe: TimeframeId,
): Promise<ParsedMarket | null> {
  try {
    const res = await fetch(`${GAMMA}/events?slug=${slug}`)
    if (!res.ok) return null
    const events = (await res.json()) as GammaEvent[]
    const event = events[0]
    if (!event?.markets?.[0] || event.closed || event.slug !== slug) return null
    const parsed = parseMarket(event, event.markets[0], coin, timeframe)
    return parsed.isLive && parsed.inWindow ? parsed : null
  } catch {
    return null
  }
}

/** Fetch gamma metadata for a resolved window (conditionId for redeem). */
export async function fetchEventConditionId(eventSlug: string): Promise<{
  conditionId: string | null
  negRisk: boolean
} | null> {
  try {
    const res = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(eventSlug)}`)
    if (!res.ok) return null
    const events = (await res.json()) as {
      markets?: { conditionId?: string; negRisk?: boolean }[]
      negRisk?: boolean
    }[]
    const event = events[0]
    const market = event?.markets?.[0]
    if (!market) return null
    const conditionId = typeof market.conditionId === 'string' ? market.conditionId : null
    const negRisk = market.negRisk === true || event.negRisk === true
    return { conditionId, negRisk }
  } catch {
    return null
  }
}

/** Current live in-window market for a coin×timeframe, via slug probing. */
export async function fetchCurrentMarket(
  coin: CoinId,
  timeframe: TimeframeId,
): Promise<ParsedMarket | null> {
  const candidates = buildEventSlugCandidates(coin, timeframe)
  const results = await Promise.all(candidates.map((slug) => fetchForSlug(slug, coin, timeframe)))
  return results.find((m): m is ParsedMarket => m?.inWindow === true) ?? null
}

/** Gamma snapshot for a specific event slug (includes ended windows — for post-close sells). */
export async function fetchMarketByEventSlug(
  eventSlug: string,
  coin: CoinId,
  timeframe: TimeframeId,
): Promise<ParsedMarket | null> {
  try {
    const res = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(eventSlug)}`)
    if (!res.ok) return null
    const events = (await res.json()) as GammaEvent[]
    const event = events[0]
    if (!event?.markets?.[0] || event.slug !== eventSlug) return null
    return parseMarket(event, event.markets[0], coin, timeframe)
  } catch {
    return null
  }
}
