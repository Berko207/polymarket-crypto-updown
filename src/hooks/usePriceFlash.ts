import { useEffect, useRef, useState } from 'react'

export type FlashDir = 'up' | 'down' | null

/**
 * Emit a transient 'up' | 'down' whenever `value` changes vs the previous render,
 * auto-clearing after `ms`. Drives a color flash so live price ticks are visible —
 * the CLOB WS for these markets is snapshot-then-sparse, so a moving number is easy
 * to miss without a cue.
 */
export function usePriceFlash(value: number | null | undefined, ms = 800): FlashDir {
  const [dir, setDir] = useState<FlashDir>(null)
  const prev = useRef<number | null | undefined>(value)

  useEffect(() => {
    const previous = prev.current
    prev.current = value
    if (value == null || previous == null || value === previous) return
    setDir(value > previous ? 'up' : 'down')
    const timer = setTimeout(() => setDir(null), ms)
    return () => clearTimeout(timer)
  }, [value, ms])

  return dir
}

/** Tailwind text-color for a flash direction — pair with `transition-colors`. */
export function flashColor(dir: FlashDir): string {
  if (dir === 'up') return 'text-up'
  if (dir === 'down') return 'text-down'
  return ''
}
