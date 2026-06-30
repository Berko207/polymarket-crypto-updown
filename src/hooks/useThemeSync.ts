import { useEffect } from 'react'
import { useUiStore } from '@/store/ui'

/** Reflect the persisted theme preference onto <html> (.dark drives the dark palette). */
export function useThemeSync() {
  const theme = useUiStore((s) => s.theme)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])
}
