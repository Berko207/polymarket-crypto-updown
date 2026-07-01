import { getCoin, getTimeframe, TIMEFRAMES } from './config'
import { timeframeFromEventSlug } from './slugs'
import type { OpenOrder, Position } from './api'
import type { ParsedMarket, TimeframeId } from './types'
import { getTokenMarketLabel } from './tokenLabels'

export interface MarketLabelParts {
  timeframe: TimeframeId | null
  timeframeLabel: string | null
  asset: string
  window: string
  short: string
}

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

function timeframeFromDisplayLabel(label: string): TimeframeId | null {
  const normalized = label.trim().toLowerCase()
  for (const tf of TIMEFRAMES) {
    if (normalized === tf.label.toLowerCase() || normalized === tf.shortLabel.toLowerCase()) {
      return tf.id
    }
  }
  return null
}

/** Parse a stored token subtitle ("15 Min · June 30, 2:00PM-2:15PM ET"). */
function parseStoredTokenLabel(stored: string): { timeframe: TimeframeId | null; window: string } {
  const sep = stored.indexOf(' · ')
  if (sep < 0) return { timeframe: null, window: stored.trim() }
  const head = stored.slice(0, sep).trim()
  const window = stored.slice(sep + 3).trim()
  return { timeframe: timeframeFromDisplayLabel(head), window }
}

function parseTitle(title: string): { asset: string; window: string } {
  const trimmed = title.trim()
  const dash = trimmed.indexOf(' - ')
  if (dash < 0) return { asset: trimmed, window: '' }
  return {
    asset: trimmed.slice(0, dash).trim(),
    window: trimmed.slice(dash + 3).trim(),
  }
}

export function formatPositionLabel(position: Position): MarketLabelParts {
  const stored = getTokenMarketLabel(position.tokenId)
  const storedParts = stored ? parseStoredTokenLabel(stored) : null

  let timeframe = timeframeFromEventSlug(position.eventSlug)
  if (!timeframe && storedParts?.timeframe) timeframe = storedParts.timeframe

  let { asset, window } =
    position.title.trim() && position.title.trim() !== 'This market'
      ? parseTitle(position.title)
      : { asset: '', window: '' }

  if (!window && storedParts?.window) window = storedParts.window

  const tfConfig = timeframe ? getTimeframe(timeframe) : null
  const timeframeLabel =
    tfConfig?.shortLabel ?? (stored ? stored.split(' · ')[0]?.trim() : null) ?? null

  const shortParts = [timeframeLabel, asset, window].filter(Boolean)
  const short =
    shortParts.length >= 2
      ? `${shortParts[0]} · ${shortParts.slice(1).join(' · ')}`
      : shortParts[0] ?? 'Position'

  return { timeframe, timeframeLabel, asset, window, short }
}

/** Group header for paired Up/Down legs in the same market window. */
export function formatMarketGroupLabel(positions: Position[]): string {
  if (positions.length === 0) return 'Market'
  const primary = formatPositionLabel(positions[0])
  if (primary.timeframeLabel && primary.window) {
    return `${primary.timeframeLabel} · ${primary.window}`
  }
  return primary.short
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

/** Timeframe bucket for a position (from event slug or stored buy label). */
export function positionTimeframe(position: Position): TimeframeId | null {
  return formatPositionLabel(position).timeframe
}

export function filterPositionsByTimeframe(
  rows: Position[],
  timeframe: TimeframeId,
): Position[] {
  return rows.filter((p) => positionTimeframe(p) === timeframe)
}

/** Group positions by coin symbol (BTC, ETH, …) within a timeframe tab. */
export function groupPositionsByCoin(positions: Position[]): Map<string, Position[]> {
  const groups = new Map<string, Position[]>()
  for (const p of positions) {
    const sym = coinSymbolFromPosition(p)
    const list = groups.get(sym) ?? []
    list.push(p)
    groups.set(sym, list)
  }
  return groups
}

/** Label for an open order (uses position title, event slug, or remembered market window). */
export function formatOrderLabel(
  order: OpenOrder,
  positions: Position[],
): MarketLabelParts {
  const position = positions.find((p) => p.tokenId === order.assetId)
  if (position) return formatPositionLabel(position)

  const stored = getTokenMarketLabel(order.assetId)
  if (stored) {
    const storedParts = parseStoredTokenLabel(stored)
    const timeframeLabel = storedParts.timeframe
      ? getTimeframe(storedParts.timeframe).shortLabel
      : stored.split(' · ')[0]?.trim() ?? null
    const short = stored
    return {
      timeframe: storedParts.timeframe,
      timeframeLabel,
      asset: 'Crypto Up/Down',
      window: storedParts.window,
      short,
    }
  }

  return {
    timeframe: null,
    timeframeLabel: null,
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
    const tf = timeframeFromDisplayLabel(first)
    if (tf) {
      // Stored label is "15 Min · …" — coin isn't in the stored string; fall through.
    }
  }
  return order.outcome.slice(0, 3).toUpperCase()
}
