import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchBotHistory,
  fetchBotStatus,
  setBotHalted,
  setBotMode,
  setBotStake,
  setBotMaxDailyTrades,
  setBotStrategy,
  setBotTradeTimeframes,
  type BotMode,
  type BotStatus,
  type HistoryFilters,
} from '@/lib/botControl'

const KEY = ['bot', 'status'] as const

/** Poll the local bot control server; fails fast to "offline" when not running. */
export function useBotStatus() {
  return useQuery({
    queryKey: KEY,
    queryFn: fetchBotStatus,
    refetchInterval: 3_000,
    retry: false,
    staleTime: 2_500,
    gcTime: 5_000,
  })
}

export function useBotMode() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (mode: BotMode) => setBotMode(mode),
    onSuccess: (status: BotStatus) => qc.setQueryData(KEY, status),
  })
}

export function useBotHalt() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (halted: boolean) => setBotHalted(halted),
    onSuccess: (status: BotStatus) => qc.setQueryData(KEY, status),
  })
}

export function useBotStake() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (stakeUsd: number) => setBotStake(stakeUsd),
    onSuccess: (status: BotStatus) => qc.setQueryData(KEY, status),
  })
}

export function useBotMaxDailyTrades() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (maxDailyTrades: number) => setBotMaxDailyTrades(maxDailyTrades),
    onSuccess: (status: BotStatus) => qc.setQueryData(KEY, status),
  })
}

export function useBotStrategy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (strategy: 'value' | 'swing') => setBotStrategy(strategy),
    onSuccess: (status: BotStatus) => qc.setQueryData(KEY, status),
  })
}

export function useBotTradeTimeframes() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (timeframes: string[]) => setBotTradeTimeframes(timeframes),
    onSuccess: (status: BotStatus) => qc.setQueryData(KEY, status),
  })
}

/** Filtered trade history; only fetches while the grid is open (`enabled`). */
export function useBotHistory(filters: HistoryFilters, enabled: boolean) {
  return useQuery({
    queryKey: ['bot', 'history', filters],
    queryFn: () => fetchBotHistory(filters),
    enabled,
    placeholderData: (prev) => prev,
    staleTime: 2_000,
  })
}
