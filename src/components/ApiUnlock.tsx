import { useState } from 'react'
import { saveApiSecret } from '../lib/apiAuth'

interface ApiUnlockProps {
  onUnlocked: () => void
}

export function ApiUnlock({ onUnlocked }: ApiUnlockProps) {
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = secret.trim()
    if (!trimmed) return

    setChecking(true)
    setError(null)
    saveApiSecret(trimmed)

    try {
      const res = await fetch('/api/account', {
        headers: { Authorization: `Bearer ${trimmed}` },
      })
      if (res.status === 401) {
        setError('Invalid access key')
        return
      }
      if (!res.ok) {
        setError(`Server error (${res.status})`)
        return
      }
      onUnlocked()
    } catch {
      setError('Could not reach the server')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="api-unlock-overlay">
      <form className="api-unlock-card" onSubmit={(e) => void handleSubmit(e)}>
        <h2>Unlock dashboard</h2>
        <p className="api-unlock-hint">
          Enter your <code>APP_API_SECRET</code> to access trading endpoints.
        </p>
        <input
          type="password"
          className="api-unlock-input"
          placeholder="Access key"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="current-password"
          autoFocus
        />
        {error && <p className="api-unlock-error">{error}</p>}
        <button type="submit" className="api-unlock-btn" disabled={checking || !secret.trim()}>
          {checking ? 'Checking…' : 'Continue'}
        </button>
      </form>
    </div>
  )
}
