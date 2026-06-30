import { useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CoinId, TimeframeId } from '@/lib/types'
import { getAvailableTimeframes } from '@/lib/config'
import {
  BALANCED_INTERVAL,
  clampBalancedIntervalMs,
  resolveUpdateConfig,
  type UpdateMode,
  type UpdateModeConfig,
} from '@/lib/updateMode'

export type ThemeMode = 'dark' | 'light'

interface UiState {
  selectedCoin: CoinId
  selectedTimeframe: TimeframeId
  updateMode: UpdateMode
  balancedIntervalMs: number
  theme: ThemeMode
  setCoin: (coin: CoinId) => void
  setTimeframe: (timeframe: TimeframeId) => void
  setUpdateMode: (mode: UpdateMode) => void
  setBalancedInterval: (ms: number) => void
  setTheme: (theme: ThemeMode) => void
  toggleTheme: () => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      selectedCoin: 'btc',
      selectedTimeframe: '5m',
      updateMode: 'live',
      balancedIntervalMs: BALANCED_INTERVAL.defaultMs,
      theme: 'dark',
      setCoin: (coin) => {
        // Keep the timeframe valid for the new coin (not all combos exist).
        const available = getAvailableTimeframes(coin)
        const current = get().selectedTimeframe
        const timeframe = available.includes(current) ? current : (available[0] ?? '5m')
        set({ selectedCoin: coin, selectedTimeframe: timeframe })
      },
      setTimeframe: (timeframe) => set({ selectedTimeframe: timeframe }),
      setUpdateMode: (mode) => set({ updateMode: mode }),
      setBalancedInterval: (ms) => set({ balancedIntervalMs: clampBalancedIntervalMs(ms) }),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
    }),
    { name: 'pm-ui' },
  ),
)

/** Resolved update-mode config (poll interval, throttle, websocket on/off). */
export function useUpdateConfig(): UpdateModeConfig {
  const mode = useUiStore((s) => s.updateMode)
  const interval = useUiStore((s) => s.balancedIntervalMs)
  return useMemo(() => resolveUpdateConfig(mode, interval), [mode, interval])
}
