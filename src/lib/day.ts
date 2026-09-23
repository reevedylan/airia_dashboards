/**
 * Civil-day arithmetic: `YYYY-MM-DD` in, `YYYY-MM-DD` out.
 *
 * All of it runs on UTC dates, which is exact rather than approximate,
 * because a civil calendar is the same in every zone: September has 30 days
 * in Sydney and in Reykjavik, and the 22nd is a Tuesday in both. Nothing
 * here knows about instants, offsets or daylight saving — turning a day into
 * a moment is a separate job, done once, where the zone is known.
 */

const pad = (n: number) => String(n).padStart(2, '0')

export type Day = string

export const dayISO = (y: number, m: number, d: number): Day => `${y}-${pad(m)}-${pad(d)}`

/** UTC midnight of a civil day — a handle for arithmetic, not an instant. */
export const dayDate = (day: Day): Date => new Date(`${day}T00:00:00Z`)

export const dayOfDate = (d: Date): Day => dayISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())

/** `{ y, m, d }` with a 1-based month, the way a date is written. */
export const dayParts = (day: Day) => {
  const [y, m, d] = day.split('-').map(Number)
  return { y, m, d }
}

export function addDays(day: Day, n: number): Day {
  const d = dayDate(day)
  d.setUTCDate(d.getUTCDate() + n)
  return dayOfDate(d)
}

/**
 * Add calendar months, CLAMPING the day of the month.
 *
 * 31 March back one month is 28 February, not 3 March. Rolling over instead
 * would make a "one month" window silently 31 days long in some months and
 * skip a date entirely in others.
 */
export function addMonths(day: Day, n: number): Day {
  const { y, m, d } = dayParts(day)
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate()
  return dayOfDate(new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))))
}

export const monthOf = (day: Day): string => day.slice(0, 7)
