import { useState } from 'react'
import { truncateAddress, type AccountStatusResponse } from '../lib/api'

interface AccountStatusProps {
  status: AccountStatusResponse | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}

export function AccountStatus({ status, loading, error, onRefresh }: AccountStatusProps) {
  const [open, setOpen] = useState(false)

  const configured = status?.configured === true
  const healthy = configured && !status?.error
  const label = loading
    ? 'Account…'
    : !configured
      ? 'Not connected'
      : healthy
        ? truncateAddress(status.address ?? '')
        : 'Auth error'

  return (
    <div className="account-status">
      <button
        type="button"
        className={`account-status-btn ${healthy ? 'connected' : configured ? 'warning' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className={`account-dot ${healthy ? 'on' : configured ? 'warn' : ''}`} />
        {label}
      </button>

      {open && (
        <div className="account-panel" role="dialog" aria-label="Trading account">
          <div className="account-panel-header">
            <strong>Server trading</strong>
            <button type="button" className="account-panel-close" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </div>

          {loading && <p className="account-hint">Checking server credentials…</p>}

          {error && (
            <p className="account-error">
              {error}
              <button type="button" onClick={() => void onRefresh()}>
                Retry
              </button>
            </p>
          )}

          {!loading && !configured && (
            <div className="account-setup">
              <p>Credentials live on the <strong>server</strong>, not in this browser.</p>
              <ol>
                <li>
                  <strong>Local:</strong> copy <code>.env.example</code> → <code>.env.local</code> and paste your keys
                </li>
                <li>
                  <strong>Vercel:</strong>{' '}
                  <a href="https://vercel.com/docs/projects/environment-variables" target="_blank" rel="noreferrer">
                    add <code>POLY_*</code> env vars
                  </a>{' '}
                  in project settings
                </li>
                <li>Run <code>pnpm dev:local</code> (Vite + API routes)</li>
              </ol>
              <p className="account-hint">GitHub stores code only. Vercel stores secrets. Never commit <code>.env.local</code>.</p>
            </div>
          )}

          {configured && (
            <dl className="account-stats">
              {status.address && (
                <div>
                  <dt>Signer</dt>
                  <dd>{truncateAddress(status.address)}</dd>
                </div>
              )}
              {status.funderAddress && (
                <div>
                  <dt>Funder</dt>
                  <dd>{truncateAddress(status.funderAddress)}</dd>
                </div>
              )}
              {status.usdcBalance != null && (
                <div>
                  <dt>USDC</dt>
                  <dd>${status.usdcBalance.toFixed(2)}</dd>
                </div>
              )}
              {status.openOrderCount != null && (
                <div>
                  <dt>Open orders</dt>
                  <dd>{status.openOrderCount}</dd>
                </div>
              )}
              <div>
                <dt>Can trade</dt>
                <dd>{status.canTrade ? 'Yes (private key on server)' : 'No — add POLY_PRIVATE_KEY'}</dd>
              </div>
            </dl>
          )}

          {status?.error && <p className="account-error">{status.error}</p>}

          <button type="button" className="account-refresh" onClick={() => void onRefresh()} disabled={loading}>
            Refresh
          </button>
        </div>
      )}
    </div>
  )
}
