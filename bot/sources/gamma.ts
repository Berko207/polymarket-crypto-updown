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

/** Current live in-window market for a coin×timeframe, via slug probing. */
export async function fetchCurrentMarket(
  coin: CoinId,
  timeframe: TimeframeId,
): Promise<ParsedMarket | null> {
  const candidates = buildEventSlugCandidates(coin, timeframe)
  const results = await Promise.all(candidates.map((slug) => fetchForSlug(slug, coin, timeframe)))
  return results.find((m): m is ParsedMarket => m?.inWindow === true) ?? null
}
