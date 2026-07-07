/**
 * Public CLOB order-book reads for live Easy gates. Gamma only ships the Up
 * top-of-book; the Down side is a complement guess that can show phantom cheap
 * asks. For live certainty entries we cross the real ask, so gates must use CLOB.
 */
const CLOB_HOST = 'https://clob.polymarket.com'

interface RawLevel {
  price?: string
  size?: string
}

function parseLevel(level: RawLevel): { price: number; size: number } | null {
  const price = Number(level.price)
  const size = Number(level.size)
  if (!(Number.isFinite(price) && Number.isFinite(size) && price > 0 && price < 1 && size > 0)) {
    return null
  }
  return { price, size }
}

/** Lowest resting ask with size > 0 (REST ladder is not sorted best-first). */
export async function fetchClobBestAsk(tokenId: string): Promise<number | null> {
  const res = await fetch(`${CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`)
  if (!res.ok) return null
  const body = (await res.json()) as { asks?: RawLevel[] }
  let best: number | null = null
  for (const level of body.asks ?? []) {
    const parsed = parseLevel(level)
    if (!parsed) continue
    if (best == null || parsed.price < best) best = parsed.price
  }
  return best
}

/** Highest resting bid with size > 0. */
export async function fetchClobBestBid(tokenId: string): Promise<number | null> {
  const res = await fetch(`${CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`)
  if (!res.ok) return null
  const body = (await res.json()) as { bids?: RawLevel[] }
  let best: number | null = null
  for (const level of body.bids ?? []) {
    const parsed = parseLevel(level)
    if (!parsed) continue
    if (best == null || parsed.price > best) best = parsed.price
  }
  return best
}
