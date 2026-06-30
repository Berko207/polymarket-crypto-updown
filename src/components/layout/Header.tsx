import { Moon, Sun } from 'lucide-react'
import { useUiStore } from '@/store/ui'
import { Button } from '@/components/ui/button'
import { UpdateModeControl } from '@/components/account/UpdateModeControl'
import { AccountStatus } from '@/components/account/AccountStatus'
import type { AccountStatusResponse } from '@/lib/api'

export interface AccountView {
  status: AccountStatusResponse | null
  loading: boolean
  error: string | null
  refresh: () => void
}

export function Header({ account }: { account: AccountView }) {
  const theme = useUiStore((s) => s.theme)
  const toggleTheme = useUiStore((s) => s.toggleTheme)

  return (
    <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-primary font-bold text-primary-foreground">
            ◆
          </span>
          <div>
            <h1 className="text-sm font-bold leading-tight">Crypto Up/Down</h1>
            <p className="text-xs text-muted-foreground">Polymarket live odds</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <UpdateModeControl />
          <AccountStatus
            status={account.status}
            loading={account.loading}
            error={account.error}
            onRefresh={account.refresh}
          />
          <Button variant="outline" size="icon" onClick={toggleTheme} aria-label="Toggle theme">
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
      </div>
    </header>
  )
}
