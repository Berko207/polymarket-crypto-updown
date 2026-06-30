const STORAGE_KEY = 'pm-api-secret'

export class ApiAuthError extends Error {
  constructor(message = 'Unauthorized') {
    super(message)
    this.name = 'ApiAuthError'
  }
}

export function getStoredApiSecret(): string | null {
  const fromEnv = import.meta.env.VITE_APP_API_SECRET as string | undefined
  if (fromEnv?.trim()) return fromEnv.trim()

  try {
    const stored = localStorage.getItem(STORAGE_KEY)?.trim()
    return stored || null
  } catch {
    return null
  }
}

export function saveApiSecret(secret: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, secret.trim())
  } catch {
    // private browsing, etc.
  }
}

export function clearApiSecret(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

export function apiAuthHeaders(extra?: Record<string, string>): HeadersInit {
  const headers: Record<string, string> = { ...extra }
  const secret = getStoredApiSecret()
  if (secret) headers.Authorization = `Bearer ${secret}`
  return headers
}

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const secret = getStoredApiSecret()
  if (secret) headers.set('Authorization', `Bearer ${secret}`)

  const res = await fetch(input, { ...init, headers })
  if (res.status === 401) {
    throw new ApiAuthError()
  }
  return res
}

export async function fetchAuthConfig(): Promise<{ authRequired: boolean }> {
  const res = await fetch('/api/auth-config')
  if (!res.ok) throw new Error(`Auth config failed (${res.status})`)
  return res.json() as Promise<{ authRequired: boolean }>
}
