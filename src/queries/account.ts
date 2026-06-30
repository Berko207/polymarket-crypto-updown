import { useQuery } from '@tanstack/react-query'
import { fetchAccountStatus } from '@/lib/api'
import { qk } from './keys'

/** Account / credential snapshot (balance, canTrade, wallet diagnostics). */
export function useAccountQuery(enabled: boolean) {
  return useQuery({
    queryKey: qk.account,
    queryFn: fetchAccountStatus,
    enabled,
    refetchInterval: 30_000,
    retry: false,
  })
}
