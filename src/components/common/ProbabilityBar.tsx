/** Up/Down split bar — single-layer fill so width always matches the numeric odds. */
export function ProbabilityBar({ upPrice }: { upPrice: number }) {
  const up = Math.min(100, Math.max(0, upPrice * 100))
  return (
    <div className="relative h-1.5 overflow-hidden rounded-full bg-down" aria-hidden="true">
      <div
        className="absolute inset-y-0 left-0 bg-up transition-[width] duration-200"
        style={{ width: `${up}%` }}
      />
    </div>
  )
}
