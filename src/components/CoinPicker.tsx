import type { CSSProperties } from 'react'
import { COINS } from '../lib/config'
import type { CoinId } from '../lib/types'

interface CoinPickerProps {
  selected: CoinId
  onChange: (coin: CoinId) => void
}

export function CoinPicker({ selected, onChange }: CoinPickerProps) {
  return (
    <div className="coin-picker" role="tablist" aria-label="Select cryptocurrency">
      {COINS.map((coin) => (
        <button
          key={coin.id}
          type="button"
          role="tab"
          aria-selected={selected === coin.id}
          className={`coin-chip ${selected === coin.id ? 'active' : ''}`}
          onClick={() => onChange(coin.id)}
          style={{ '--coin-color': coin.color } as CSSProperties}
        >
          <span className="coin-icon">{coin.icon}</span>
          <span className="coin-symbol">{coin.symbol}</span>
        </button>
      ))}
    </div>
  )
}
