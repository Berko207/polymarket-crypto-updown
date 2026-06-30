import { getCoin, getTimeframe } from './config'
import type { OpenOrder, Position } from './api'
import type { ParsedMarket } from './types'
import { getTokenMarketLabel } from './tokenLabels'

/** Window text after "Coin Up or Down - " in a Polymarket title. */
export function marketWindowLabel(title: string): string {
  const dash = title.indexOf(' - ')
  if (dash >= 0) return title.slice(dash + 3).trim()
  return title.trim()
}

export function formatMarketHeading(market: ParsedMarket): { title: string; subtitle: string } {
  const coin = getCoin(market.coin)
  const tf = getTimeframe(market.timeframe)
  return {
    title: `${coin.name} Up or Down`,
    subtitle: `${tf.label} · ${marketWindowLabel(market.title)}`,
  }
}

export function formatPositionLabel(position: Position): {
  asset: string
  window: string
  short: string
} {
  const title = position.title.trim()
  const dash = title.indexOf(' - ')
  if (dash < 0) {
    return { asset: title, window: '', short: title }
  }
  const asset = title.slice(0, dash).trim()
  const window = title.slice(dash + 3).trim()
  return { asset, window, short: window ? `${asset} · ${window}` : asset }
}

export function coinSymbolFromPosition(position: Position): string {
  const { asset } = formatPositionLabel(position)
  const match = asset.match(/^(\w+)/)
  if (!match) return asset.slice(0, 8)
  const word = match[1].toLowerCase()
  const known: Record<string, string> = {
    bitcoin: 'BTC',
    ethereum: 'ETH',
    solana: 'SOL',
    dogecoin: 'DOGE',
    doge: 'DOGE',
  }
  return known[word] ?? word.slice(0, 4).toUpperCase()
}

/** Label for an open order (uses position title or remembered market window). */
export function formatOrderLabel(
  order: OpenOrder,
  positions: Position[],
): { asset: string; window: string; short: string } {
  const position = positions.find((p) => p.tokenId === order.assetId)
  if (position) return formatPositionLabel(position)

  const stored = getTokenMarketLabel(order.assetId)
  if (stored) {
    const dash = stored.indexOf(' · ')
    if (dash >= 0) {
      return {
        asset: stored.slice(0, dash).trim(),
        window: stored.slice(dash + 3).trim(),
        short: stored,
      }
    }
    return { asset: 'Crypto Up/Down', window: stored, short: stored }
  }

  return {
    asset: 'Crypto Up/Down',
    window: `${order.side} ${order.outcome}`,
    short: `${order.side} ${order.outcome}`,
  }
}

export function coinSymbolFromOrder(order: OpenOrder, positions: Position[]): string {
  const position = positions.find((p) => p.tokenId === order.assetId)
  if (position) return coinSymbolFromPosition(position)
  const stored = getTokenMarketLabel(order.assetId)
  if (stored) {
    const first = stored.split(' · ')[0]?.trim() ?? ''
    if (first) {
      const word = first.split(/\s+/)[0]?.toLowerCase() ?? ''
      const known: Record<string, string> = {
        bitcoin: 'BTC',
        btc: 'BTC',
        ethereum: 'ETH',
        eth: 'ETH',
        solana: 'SOL',
        sol: 'SOL',
      }
      if (known[word]) return known[word]
    }
  }
  return order.outcome.slice(0, 3).toUpperCase()
}
