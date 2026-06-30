const STORAGE_KEY = 'pm-token-labels'

function loadMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

function saveMap(map: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // ignore
  }
}

/** Remember which market window a token belongs to (survives timeframe switches). */
export function rememberTokenMarketLabel(tokenId: string, subtitle: string): void {
  const id = tokenId.trim()
  const label = subtitle.trim()
  if (!id || !label) return
  const map = loadMap()
  map[id] = label
  saveMap(map)
}

export function rememberMarketTokens(
  upTokenId: string | null,
  downTokenId: string | null,
  subtitle: string,
): void {
  if (upTokenId) rememberTokenMarketLabel(upTokenId, subtitle)
  if (downTokenId) rememberTokenMarketLabel(downTokenId, subtitle)
}

export function getTokenMarketLabel(tokenId: string): string | null {
  return loadMap()[tokenId] ?? null
}
