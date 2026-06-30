import { useCallback, useMemo, useState } from 'react'
import {
  clampBalancedIntervalMs,
  loadBalancedIntervalMs,
  loadUpdateMode,
  resolveUpdateConfig,
  saveBalancedIntervalMs,
  saveUpdateMode,
  type UpdateMode,
} from '../lib/updateMode'

export function useUpdateMode() {
  const [mode, setMode] = useState<UpdateMode>(loadUpdateMode)
  const [balancedIntervalMs, setBalancedIntervalMs] = useState(loadBalancedIntervalMs)

  const selectMode = useCallback((next: UpdateMode) => {
    setMode(next)
    saveUpdateMode(next)
  }, [])

  const setBalancedInterval = useCallback((ms: number) => {
    const clamped = clampBalancedIntervalMs(ms)
    setBalancedIntervalMs(clamped)
    saveBalancedIntervalMs(clamped)
  }, [])

  const config = useMemo(
    () => resolveUpdateConfig(mode, balancedIntervalMs),
    [mode, balancedIntervalMs],
  )

  return {
    mode,
    config,
    balancedIntervalMs,
    selectMode,
    setBalancedInterval,
  }
}
