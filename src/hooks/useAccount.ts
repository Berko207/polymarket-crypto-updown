import { useCallback, useEffect, useState } from 'react'
import { ApiAuthError, fetchAccountStatus, type AccountStatusResponse } from '../lib/api'

export function useAccount(enabled = true) {
  const [status, setStatus] = useState<AccountStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await fetchAccountStatus()
      setStatus(next)
      return next
    } catch (e) {
      if (e instanceof ApiAuthError) {
        const message = 'Invalid or missing API access key'
        setError(message)
        throw e
      }
      const message = e instanceof Error ? e.message : 'Could not load account'
      setError(message)
      throw e
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    refresh().catch(() => {
      /* surfaced via error state */
    })
  }, [refresh, enabled])

  return { status, loading, error, refresh }
}
