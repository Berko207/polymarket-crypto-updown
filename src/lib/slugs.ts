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

/** Infer market timeframe from a Polymarket event slug. */
export function timeframeFromEventSlug(slug: string): TimeframeId | null {
  if (!slug) return null
  const lower = slug.toLowerCase()

  const rolling = lower.match(/-updown-(5m|15m|4h)-\d+/)
  if (rolling) return rolling[1] as TimeframeId

  if (lower.includes('up-or-down-5m') || lower.includes('updown-5m')) return '5m'
  if (lower.includes('up-or-down-15m') || lower.includes('updown-15m')) return '15m'
  if (lower.includes('up-or-down-4h') || lower.includes('updown-4h')) return '4h'
  if (lower.includes('up-or-down-on-')) return 'daily'
  if (lower.includes('up-or-down-hourly')) return '1h'
  if (/up-or-down-[a-z]+-\d+-\d+-\d+(am|pm)-et/.test(lower)) return '1h'

  return null
}

/** ET wall-clock hour → UTC instant (tries EDT then EST offsets, verified via Intl). */
function etWallTimeToUtc(year: number, month: number, day: number, hour: number): Date {
  for (const offset of [4, 5]) {
    const guess = new Date(Date.UTC(year, month - 1, day, hour + offset))
    const p = getEtParts(guess)
    if (p.year === year && p.month === month && p.day === day && p.hour === hour) return guess
  }
  return new Date(Date.UTC(year, month - 1, day, hour + 5))
}

/**
 * Window end derived from the event slug — the only end-time source for positions,
 * which carry no endDate. Rolling slugs embed the window-start unix ts; hourly slugs
 * name the ET hour; daily windows settle at NOON ET on the slug's date, not midnight
 * (verified against gamma endDate across every live coin×timeframe combo).
 */
export function windowEndFromEventSlug(slug: string): Date | null {
  if (!slug) return null
  const lower = slug.toLowerCase()

  const rolling = lower.match(/-updown-(5m|15m|4h)-(\d{10})$/)
  if (rolling) {
    const interval = INTERVAL_SEC[rolling[1] as TimeframeId]
    if (!interval) return null
    return new Date((Number(rolling[2]) + interval) * 1000)
  }

  const months = MONTHS as readonly string[]

  const hourly = lower.match(/-up-or-down-([a-z]+)-(\d{1,2})-(\d{4})-(\d{1,2})(am|pm)-et$/)
  if (hourly) {
    const month = months.indexOf(hourly[1]) + 1
    if (month < 1) return null
    let hour = Number(hourly[4]) % 12
    if (hourly[5] === 'pm') hour += 12
    const start = etWallTimeToUtc(Number(hourly[3]), month, Number(hourly[2]), hour)
    return new Date(start.getTime() + 3_600_000)
  }

  const daily = lower.match(/-up-or-down-on-([a-z]+)-(\d{1,2})-(\d{4})$/)
  if (daily) {
    const month = months.indexOf(daily[1]) + 1
    if (month < 1) return null
    return etWallTimeToUtc(Number(daily[3]), month, Number(daily[2]), 12)
  }

  return null
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
