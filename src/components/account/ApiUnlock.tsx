import { useState } from 'react'
import { saveApiSecret } from '@/lib/apiAuth'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export function ApiUnlock({ onUnlocked }: { onUnlocked: () => void }) {
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
      const res = await fetch('/api/account', { headers: { Authorization: `Bearer ${trimmed}` } })
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
    <div className="grid min-h-dvh place-items-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Unlock dashboard</CardTitle>
          <CardDescription>
            Enter your <code>APP_API_SECRET</code> to access trading endpoints.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
            <Input
              type="password"
              placeholder="Access key"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
            {error && <p className="text-sm text-down">{error}</p>}
            <Button type="submit" disabled={checking || !secret.trim()}>
              {checking ? 'Checking…' : 'Continue'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
