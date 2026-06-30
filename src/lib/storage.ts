/**
 * Tiny typed localStorage wrapper. Centralizes the try/catch boilerplate that
 * was previously copy-pasted across apiAuth / updateMode / tokenLabels.
 */

export function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // private browsing / quota — non-fatal
  }
}

export function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

/** Plain-string variants for values that aren't JSON-encoded (e.g. a raw secret). */
export function readStorageString(key: string): string | null {
  try {
    return localStorage.getItem(key)?.trim() || null
  } catch {
    return null
  }
}

export function writeStorageString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value.trim())
  } catch {
    // ignore
  }
}
