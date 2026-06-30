import { Gauge, Minus, Plus } from 'lucide-react'
import { BALANCED_INTERVAL, UPDATE_MODES, formatIntervalMs } from '@/lib/updateMode'
import { useUiStore } from '@/store/ui'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

export function UpdateModeControl() {
  const mode = useUiStore((s) => s.updateMode)
  const setMode = useUiStore((s) => s.setUpdateMode)
  const interval = useUiStore((s) => s.balancedIntervalMs)
  const setInterval = useUiStore((s) => s.setBalancedInterval)

  const current = UPDATE_MODES.find((m) => m.id === mode)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Gauge className="size-3.5" />
          <span className="hidden sm:inline">{current?.label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60">
        <p className="mb-2 text-sm font-semibold">Update speed</p>
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(v) => v && setMode(v as typeof mode)}
          variant="outline"
          size="sm"
          className="w-full"
        >
          {UPDATE_MODES.map((option) => (
            <ToggleGroupItem key={option.id} value={option.id} className="flex-1" title={option.description}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {mode === 'balanced' && (
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Interval</span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => setInterval(interval - BALANCED_INTERVAL.stepMs)}
                disabled={interval <= BALANCED_INTERVAL.minMs}
                aria-label="Slower updates"
              >
                <Minus className="size-3.5" />
              </Button>
              <span className="w-12 text-center text-xs font-bold tabular-nums">{formatIntervalMs(interval)}</span>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => setInterval(interval + BALANCED_INTERVAL.stepMs)}
                disabled={interval >= BALANCED_INTERVAL.maxMs}
                aria-label="Faster updates"
              >
                <Plus className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">{current?.description}</p>
      </PopoverContent>
    </Popover>
  )
}
