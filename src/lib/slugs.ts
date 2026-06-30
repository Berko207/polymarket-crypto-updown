import type { CoinId, TimeframeId } from './types'

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const

const HOURLY_NAMES: Partial<Record<CoinId, string>> = {
  btc: 'bitcoin',
  eth: 'ethereum',
  xrp: 'xrp',
  doge: 'dogecoin',
  bnb: 'bnb',
}

const DAILY_NAMES: Partial<Record<CoinId, string>> = {
  btc: 'bitcoin',
  eth: 'ethereum',
  sol: 'solana',
  xrp: 'xrp',
  doge: 'dogecoin',
  bnb: 'bnb',
}

const INTERVAL_SEC: Partial<Record<TimeframeId, number>> = {
  '5m': 300,
  '15m': 900,
  '4h': 14_400,
}

function formatHourEt(hour: number): string {
  if (hour === 0) return '12am'
  if (hour < 12) return `${hour}am`
  if (hour === 12) return '12pm'
  return `${hour - 12}pm`
}

function getEtParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date)

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0)

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
  }
}

function buildHourlySlug(coin: CoinId, date: Date): string | null {
  const name = HOURLY_NAMES[coin]
  if (!name) return null

  const { year, month, day, hour } = getEtParts(date)
  return `${name}-up-or-down-${MONTHS[month - 1]}-${day}-${year}-${formatHourEt(hour)}-et`
}

function buildDailySlug(coin: CoinId, date: Date): string | null {
  const name = DAILY_NAMES[coin]
  if (!name) return null

  const { year, month, day } = getEtParts(date)
  return `${name}-up-or-down-on-${MONTHS[month - 1]}-${day}-${year}`
}

function buildRollingSlug(coin: CoinId, timeframe: '5m' | '15m' | '4h', ts: number): string {
  return `${coin}-updown-${timeframe}-${ts}`
}

function addHoursEt(base: Date, hours: number): Date {
  return new Date(base.getTime() + hours * 3_600_000)
}

function addDaysEt(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86_400_000)
}

/** Candidate event slugs to try, most likely first. */
export function buildEventSlugCandidates(coin: CoinId, timeframe: TimeframeId): string[] {
  const now = new Date()
  const slugs: string[] = []

  if (timeframe === '5m' || timeframe === '15m' || timeframe === '4h') {
    const interval = INTERVAL_SEC[timeframe]!
    const baseTs = Math.floor(now.getTime() / 1000 / interval) * interval
    for (const offset of [0, -1, 1, 2]) {
      slugs.push(buildRollingSlug(coin, timeframe, baseTs + offset * interval))
    }
    return slugs
  }

  if (timeframe === '1h') {
    for (const offset of [0, -1, 1, 2]) {
      const slug = buildHourlySlug(coin, addHoursEt(now, offset))
      if (slug) slugs.push(slug)
    }
    return slugs
  }

  if (timeframe === 'daily') {
    for (const offset of [0, -1, 1]) {
      const slug = buildDailySlug(coin, addDaysEt(now, offset))
      if (slug) slugs.push(slug)
    }
    return slugs
  }

  return slugs
}
