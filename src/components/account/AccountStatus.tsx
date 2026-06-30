import { truncateAddress, type AccountStatusResponse } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

function Row({ label, value, fix }: { label: string; value: string; fix?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('font-medium', fix && 'font-bold text-primary')}>{value}</dd>
    </div>
  )
}

export function AccountStatus({
  status,
  loading,
  error,
  onRefresh,
}: {
  status: AccountStatusResponse | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}) {
  const configured = status?.configured === true
  const healthy = configured && !status?.error
  const label = loading
    ? 'Account…'
    : !configured
      ? 'Not connected'
      : healthy
        ? truncateAddress(status?.address ?? '')
        : 'Auth error'

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('gap-1.5', healthy && 'border-up/40', configured && !healthy && 'border-down/40')}
          aria-haspopup="dialog"
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              healthy ? 'bg-up' : configured ? 'bg-amber-500' : 'bg-muted-foreground',
            )}
          />
          <span className="max-w-28 truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="mb-2 text-sm font-semibold">Server trading</p>

        {loading && <p className="text-sm text-muted-foreground">Checking server credentials…</p>}

        {error && (
          <p className="text-sm text-down">
            {error}{' '}
            <button type="button" className="underline" onClick={onRefresh}>
              Retry
            </button>
          </p>
        )}

        {!loading && !configured && (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Credentials live on the <strong className="text-foreground">server</strong>, not in this browser.
            </p>
            <ol className="ml-4 list-decimal space-y-1">
              <li>
                <strong className="text-foreground">Local:</strong> copy <code>.env.example</code> → <code>.env.local</code> and paste your keys
              </li>
              <li>
                <strong className="text-foreground">Vercel:</strong> add <code>POLY_*</code> env vars in project settings
              </li>
              <li>
                Run <code>pnpm dev:local</code>
              </li>
            </ol>
          </div>
        )}

        {configured && status && (
          <dl className="space-y-2">
            {status.address && <Row label="Signer" value={truncateAddress(status.address)} />}
            {status.funderAddress && <Row label="Funder" value={truncateAddress(status.funderAddress)} />}
            {status.suggestedFunderAddress && status.funderMismatch && (
              <Row label="Should be" value={truncateAddress(status.suggestedFunderAddress)} fix />
            )}
            {status.usdcBalance != null && <Row label="USDC" value={`$${status.usdcBalance.toFixed(2)}`} />}
            {status.openOrderCount != null && <Row label="Open orders" value={String(status.openOrderCount)} />}
            <Row label="Can trade" value={status.canTrade ? 'Yes' : 'No — add POLY_PRIVATE_KEY'} />
            {status.signatureType != null && <Row label="Signature type" value={String(status.signatureType)} />}
          </dl>
        )}

        {status?.funderMismatch && status.suggestedFunderAddress && (
          <p className="mt-2 text-xs text-down">
            Funder must be your Polymarket trading wallet. Set{' '}
            <code>POLY_FUNDER_ADDRESS={truncateAddress(status.suggestedFunderAddress)}</code> and{' '}
            <code>POLY_SIGNATURE_TYPE=3</code>, then restart.
          </p>
        )}
        {status?.walletSetupIssue && <p className="mt-2 text-xs text-down">{status.walletSetupIssue}</p>}
        {status?.error && <p className="mt-2 text-xs text-down">{status.error}</p>}

        <Button variant="secondary" size="sm" className="mt-3 w-full" onClick={onRefresh} disabled={loading}>
          Refresh
        </Button>
      </PopoverContent>
    </Popover>
  )
}
