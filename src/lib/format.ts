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

const FMT: Record<Grain, Intl.DateTimeFormat> = {
  minute: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }),
  // An hour-grain range spans days, so a bare "22:00" at each end is
  // ambiguous — the day has to be on the label.
  hour: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  day: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }),
  month: new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit' }),
}

/** Short axis-tick label, e.g. "22 Feb" or "14:00". */
export const axisDate = (t: number, grain: Grain): string => FMT[grain].format(new Date(t))

const TOOLTIP_FMT: Record<Grain, Intl.DateTimeFormat> = {
  minute: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  hour: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  day: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
  month: new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }),
}

/** Unambiguous label for tooltips. */
export const fullDate = (t: number, grain: Grain): string => TOOLTIP_FMT[grain].format(new Date(t))

const STAMP_DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const STAMP_TIME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/**
 * Row stamp for the table view. Pass `withTime` when consecutive rows are
 * less than a day apart, or the table shows the same date twice for two
 * different values.
 */
export const stamp = (t: number, withTime: boolean): string =>
  (withTime ? STAMP_TIME : STAMP_DAY).format(new Date(t))
