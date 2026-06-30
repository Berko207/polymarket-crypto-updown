import { getAvailableTimeframes, getTimeframe } from '../lib/config'
import type { CoinId, TimeframeId } from '../lib/types'

interface TimeframeTabsProps {
  coin: CoinId
  selected: TimeframeId
  onChange: (timeframe: TimeframeId) => void
}

export function TimeframeTabs({ coin, selected, onChange }: TimeframeTabsProps) {
  const available = getAvailableTimeframes(coin)

  return (
    <div className="timeframe-scroll">
      <div className="timeframe-tabs" role="tablist" aria-label="Select timeframe">
        {available.map((id) => {
          const tf = getTimeframe(id)
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected === id}
              className={`timeframe-tab ${selected === id ? 'active' : ''}`}
              onClick={() => onChange(id)}
            >
              {tf.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
