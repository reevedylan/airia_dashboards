/** Number, currency and date formatting shared by every chart. */

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const FULL = new Intl.NumberFormat('en-US')

/** 1_284 → "1,284"; 1_284_000 → "1.3M". For axis ticks and dense labels. */
export const compact = (n: number): string => (Math.abs(n) < 10_000 ? FULL.format(Math.round(n)) : COMPACT.format(n))

/** Always grouped, never abbreviated. For hero figures and table cells. */
export const full = (n: number, maxFrac = 0): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: maxFrac })

export const currency = (n: number, maxFrac = 2): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: maxFrac, maximumFractionDigits: maxFrac })

export const currencyCompact = (n: number): string =>
  Math.abs(n) < 10_000 ? currency(n, 2) : '$' + COMPACT.format(n)

/** Seconds with a unit, e.g. "6.058 s". */
export const seconds = (n: number, digits = 3): string => `${n.toFixed(digits)} s`

export const percent = (fraction: number, digits = 1): string => `${(fraction * 100).toFixed(digits)}%`

/**
 * A share, floored so a present-but-tiny slice never reads as exactly zero.
 * The long tail of a ranked list is full of 0.04% entries, and "0.0%" says
 * they contributed nothing.
 */
export const share = (fraction: number | null | undefined, digits = 1): string => {
  if (fraction == null || !Number.isFinite(fraction)) return '—'
  const floor = 1 / 10 ** (digits + 2)
  if (fraction > 0 && fraction < floor) return `<${percent(floor, digits)}`
  return percent(fraction, digits)
}

/* ---------------------------------------------------------------- dates -- */

/** How wide a span is, which drives tick density and label shape. */
export type Grain = 'minute' | 'hour' | 'day' | 'month'

export function grainFor(spanMs: number): Grain {
  const h = spanMs / 3_600_000
  if (h <= 6) return 'minute'
  if (h <= 72) return 'hour'
  if (h <= 24 * 120) return 'day'
  return 'month'
}


const TOOLTIP_FMT: Record<Grain, Intl.DateTimeFormat> = {
  minute: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  hour: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  day: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
  month: new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }),
}

/**
 * Span-derived tooltip label — the charts' FALLBACK only.
 *
 * Prefer `bucketFormat()`: inferring a format from the total span drops the
 * time of day on any range wider than about three days, which is how a
 * 12-hour bucket ended up labelled with no AM/PM.
 */
export const fullDate = (t: number, grain: Grain): string => TOOLTIP_FMT[grain].format(new Date(t))


/* ------------------------------------------------------ bucket labelling -- */

export interface BucketFormat {
  /** Compact label for the axis extent under a plot. */
  tick: (t: number) => string
  /** Full label naming the span a bucket covers, for tooltips and tables. */
  label: (start: number, end: number) => string
}

/**
 * Labels derived from the BUCKET SIZE, not from the chart's total span, and
 * rendered in the zone the buckets were aligned to.
 *
 * Both parts matter. Deriving the format from the span put 7D (2-hour
 * buckets), 14D (4-hour) and 1M (12-hour) into a date-only format, so there
 * was no way to tell which block you were hovering — on 1M, not even AM from
 * PM. And because the buckets are aligned to `zone`, labelling them in the
 * viewer's own zone would show a bucket that starts at local midnight as some
 * arbitrary hour.
 */
export function bucketFormat(bucketMs: number, zone: string): BucketFormat {
  const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, ...opts })
  const dayShort = fmt({ day: 'numeric', month: 'short' })
  const dayMid = fmt({ weekday: 'short', day: 'numeric', month: 'short' })
  const dayLong = fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  const time = fmt({ hour: '2-digit', minute: '2-digit', hour12: false })

  // en-AU yields "AEST"/"AEDT"; most other locales give "GMT+10".
  const zoneFmt = new Intl.DateTimeFormat('en-AU', { timeZone: zone, timeZoneName: 'short' })
  const zoneAbbr = (t: number) =>
    zoneFmt.formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName')?.value ?? ''

  const isDaily = bucketMs % 86_400_000 === 0
  const isHalfDay = bucketMs === 43_200_000

  /** A bucket that ends at midnight reads far better as 24:00 than as 00:00. */
  const endTime = (t: number) => {
    const s = time.format(new Date(t))
    return s === '00:00' ? '24:00' : s
  }

  return {
    tick: (t) => (isDaily ? dayShort.format(new Date(t)) : `${dayShort.format(new Date(t))}, ${time.format(new Date(t))}`),
    label: (start, end) => {
      if (isDaily) {
        const days = Math.round(bucketMs / 86_400_000)
        return days === 1
          ? dayLong.format(new Date(start))
          : `${dayShort.format(new Date(start))} – ${dayShort.format(new Date(end - 1))}`
      }
      const span = `${time.format(new Date(start))}–${endTime(end)}`
      const half = isHalfDay ? `${time.format(new Date(start)).startsWith('00') ? 'AM' : 'PM'} ` : ''
      return `${dayMid.format(new Date(start))} · ${half}${span} ${zoneAbbr(start)}`
    },
  }
}
