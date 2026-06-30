import {
  BALANCED_INTERVAL,
  UPDATE_MODES,
  formatIntervalMs,
  type UpdateMode,
} from '../lib/updateMode'

interface UpdateModeControlProps {
  mode: UpdateMode
  balancedIntervalMs: number
  onChange: (mode: UpdateMode) => void
  onBalancedIntervalChange: (ms: number) => void
}

export function UpdateModeControl({
  mode,
  balancedIntervalMs,
  onChange,
  onBalancedIntervalChange,
}: UpdateModeControlProps) {
  const step = (delta: number) => {
    onBalancedIntervalChange(balancedIntervalMs + delta)
  }

  return (
    <div className="update-mode-wrap">
      <div className="update-mode" role="group" aria-label="Update speed">
        {UPDATE_MODES.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`update-mode-btn ${mode === option.id ? 'active' : ''}`}
            onClick={() => onChange(option.id)}
            aria-pressed={mode === option.id}
            title={option.description}
          >
            {option.label}
          </button>
        ))}
      </div>

      {mode === 'balanced' && (
        <div className="balanced-interval" aria-label="Balanced update interval">
          <button
            type="button"
            className="interval-step"
            onClick={() => step(-BALANCED_INTERVAL.stepMs)}
            disabled={balancedIntervalMs <= BALANCED_INTERVAL.minMs}
            aria-label="Slower updates"
          >
            −
          </button>
          <span className="interval-value">{formatIntervalMs(balancedIntervalMs)}</span>
          <button
            type="button"
            className="interval-step"
            onClick={() => step(BALANCED_INTERVAL.stepMs)}
            disabled={balancedIntervalMs >= BALANCED_INTERVAL.maxMs}
            aria-label="Faster updates"
          >
            +
          </button>
        </div>
      )}
    </div>
  )
}
