export type CoinId = 'btc' | 'eth' | 'sol' | 'xrp' | 'doge' | 'bnb'

export type TimeframeId = '5m' | '15m' | '1h' | '4h' | 'daily'

export interface CoinConfig {
  id: CoinId
  name: string
  symbol: string
  color: string
  icon: string
}

export interface TimeframeConfig {
  id: TimeframeId
  label: string
  shortLabel: string
}

export interface GammaMarket {
  id: string
  question: string
  slug: string
  outcomes: string
  outcomePrices: string
  volume: string
  volumeNum?: number
  liquidityNum?: number
  endDate: string
  bestBid?: number
  bestAsk?: number
  lastTradePrice?: number
  oneHourPriceChange?: number
  spread?: number
  clobTokenIds?: string
  eventStartTime?: string
  acceptingOrders?: boolean
  active?: boolean
  /** Whether this market is part of a negative-risk event (binary up/down = false). */
  negRisk?: boolean
  /** Minimum price increment, e.g. 0.01 / 0.001. Authoritative metadata from gamma. */
  orderPriceMinTickSize?: number
}

export interface GammaEvent {
  id: string
  slug: string
  title: string
  description?: string
  endDate: string
  startDate?: string
  startTime?: string
  closed: boolean
  active: boolean
  volume?: number
  liquidity?: number
  volume24hr?: number
  eventMetadata?: { priceToBeat?: number }
  markets?: GammaMarket[]
}

export interface GammaSeries {
  id: string
  slug: string
  title: string
  recurrence: string
  volume24hr?: number
  liquidity?: number
  events?: GammaEvent[]
}

export interface ParsedMarket {
  eventSlug: string
  title: string
  coin: CoinId
  timeframe: TimeframeId
  upPrice: number
  downPrice: number
  volume: number
  liquidity: number
  endDate: Date
  startDate: Date | null
  upTokenId: string | null
  downTokenId: string | null
  bestBidUp: number | null
  bestAskUp: number | null
  bestBidDown: number | null
  bestAskDown: number | null
  priceChange1h: number | null
  polymarketUrl: string
  /** Order metadata from gamma — passed to the order API so the server skips CLOB lookups. */
  negRisk: boolean | null
  tickSize: number | null
  /** Market is open for trading (matches Polymarket "Live") */
  isLive: boolean
  /** Price measurement window is currently active */
  inWindow: boolean
  /** Strike from gamma eventMetadata — authoritative when present. */
  priceToBeat: number | null
}
