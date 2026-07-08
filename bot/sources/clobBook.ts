/**
 * Public CLOB order-book reads for live Easy gates. Gamma only ships the Up
 * top-of-book; the Down side is a complement guess that can show phantom cheap
 * asks. For live certainty entries we cross the real ask, so gates must use CLOB.
 */
const CLOB_HOST = 'https://clob.polymarket.com'
/** Abort hung REST reads so a slow book cannot freeze the main tick loop. */
const FETCH_MS = 4_000
/** Coalesce duplicate token reads within a tick (many scopes share tokens). */
const CACHE_MS = 750

interface RawLevel {
  price?: string
  size?: string
}

interface BookTop {
  at: number
  bestAsk: number | null
  bestBid: number | null
}

const cache = new Map<string, BookTop>()
const inflight = new Map<string, Promise<BookTop | null>>()

function parseLevel(level: RawLevel): { price: number; size: number } | null {
  const price = Number(level.price)
  const size = Number(level.size)
  if (!(Number.isFinite(price) && Number.isFinite(size) && price > 0 && price < 1 && size > 0)) {
    return null
  }
  return { price, size }
}

function bestAsk(levels: RawLevel[] | undefined): number | null {
  let best: number | null = null
  for (const level of levels ?? []) {
    const parsed = parseLevel(level)
    if (!parsed) continue
    if (best == null || parsed.price < best) best = parsed.price
  }
  return best
}

function bestBid(levels: RawLevel[] | undefined): number | null {
  let best: number | null = null
  for (const level of levels ?? []) {
    const parsed = parseLevel(level)
    if (!parsed) continue
    if (best == null || parsed.price > best) best = parsed.price
  }
  return best
}

async function fetchBookTop(tokenId: string): Promise<BookTop | null> {
  const now = Date.now()
  const hit = cache.get(tokenId)
  if (hit && now - hit.at < CACHE_MS) return hit

  const pending = inflight.get(tokenId)
  if (pending) return pending

  const p = (async (): Promise<BookTop | null> => {
    try {
      const res = await fetch(`${CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`, {
        signal: AbortSignal.timeout(FETCH_MS),
      })
      if (!res.ok) return null
      const body = (await res.json()) as { asks?: RawLevel[]; bids?: RawLevel[] }
      const entry: BookTop = {
        at: Date.now(),
        bestAsk: bestAsk(body.asks),
        bestBid: bestBid(body.bids),
      }
      cache.set(tokenId, entry)
      return entry
    } catch {
      return null
    } finally {
      inflight.delete(tokenId)
    }
  })()
  inflight.set(tokenId, p)
  return p
}

/** Lowest resting ask with size > 0 (REST ladder is not sorted best-first). */
export async function fetchClobBestAsk(tokenId: string): Promise<number | null> {
  const book = await fetchBookTop(tokenId)
  return book?.bestAsk ?? null
}

/** Highest resting bid with size > 0. */
export async function fetchClobBestBid(tokenId: string): Promise<number | null> {
  const book = await fetchBookTop(tokenId)
  return book?.bestBid ?? null
}
