import { addDays, addMonths, dayISO, dayParts, spanDays, type Day } from '../day'

/**
 * Turns raw AIOperationExecutions rows into the sparse fact table the
 * dashboard folds. Pure: no DOM, no network, no React — so it can be tested
 * and reasoned about on its own.
 */

export interface RawRow {
  executionDateTime: string
  executionSourceType?: string
  providerType?: string
  modelName?: string
  userEmail?: string | null
  inputTokenCountConsumed?: number
  cachedInputTokenCountConsumed?: number
  outputTokenCountConsumed?: number
  totalTokenCountConsumed?: number
  inputTokenAmountConsumed?: string | number | null
  cachedInputTokenAmountConsumed?: string | number | null
  outputTokenAmountConsumed?: string | number | null
  totalTokenAmountConsumed?: string | number | null
  additionalCharges?: Record<string, string | number> | null
}

/**
 * Every field the aggregation reads, and nothing else.
 *
 * Kept beside `RawRow` because it IS `RawRow`: add a field there and add it
 * here, or the new field will be silently dropped before it is ever summed.
 *
 * Rows are projected to this shape as they arrive, because they are held for
 * as long as the tab is open so that moving the window is a re-fold rather
 * than a re-fetch. A full response row costs ~780 bytes of heap; this keeps
 * ~470, which is the difference between holding a year of history and not.
 * Every row survives the projection — only unread fields are dropped — so
 * the fetched-row counts the footer reconciles against are unaffected.
 */
const KEPT: readonly (keyof RawRow)[] = [
  'executionDateTime', 'executionSourceType', 'providerType', 'modelName', 'userEmail',
  'inputTokenCountConsumed', 'cachedInputTokenCountConsumed', 'outputTokenCountConsumed',
  'totalTokenCountConsumed',
  'inputTokenAmountConsumed', 'cachedInputTokenAmountConsumed', 'outputTokenAmountConsumed',
  'totalTokenAmountConsumed', 'additionalCharges',
]

export function slim(row: RawRow): RawRow {
  const out: Partial<RawRow> = {}
  for (const k of KEPT) if (row[k] != null) (out as Record<string, unknown>)[k] = row[k]
  return out as RawRow
}

/**
 * Bucket size and extent per range.
 *
 * Two kinds of window, and the difference is deliberate:
 *
 * - `count` — a FIXED number of buckets ending with the one containing the
 *   anchor. Window length is always `count x bucketMs`.
 * - `months` — a CALENDAR window. A month is not 30 days, so 1M and 3M are
 *   measured in months rather than in bars: a 1M window ending 3 April
 *   starts on 4 March, and a 3M window ending 3 June starts on 4 March too.
 *   The bar count therefore varies with the month (a 1M window is 56 to 62
 *   half-days), which is the point — a fixed 30-day window drifts off the
 *   calendar a little further every month.
 *
 * A calendar window is whole local days, so it still lands exactly on the
 * bucket grid at both ends.
 */
export const RANGE_SPECS = {
  '24H': { bucketMs: 15 * 60_000, count: 96 },
  '7D': { bucketMs: 2 * 3_600_000, count: 84 },
  '14D': { bucketMs: 4 * 3_600_000, count: 84 },
  '1M': { bucketMs: 12 * 3_600_000, months: 1 },
  '3M': { bucketMs: 24 * 3_600_000, months: 3 },
} as const

export type RangeSpec = (typeof RANGE_SPECS)[keyof typeof RANGE_SPECS]
/** True for the calendar-measured ranges, whose bar count is not fixed. */
export const isCalendar = (s: RangeSpec): s is Extract<RangeSpec, { months: number }> =>
  'months' in s

export type RangeName = keyof typeof RANGE_SPECS

/** Requests with no user — made with the tenant's standard service key rather
 *  than an individual's. About a third of gateway traffic. */
export const SERVICE_KEY = 'Standard Key (service)'

/* --------------------------------------------------------------- decimal -- */

/**
 * The API returns money as strings with up to 11 decimal places. Accumulating
 * those as floats drifts over 10^5 rows, so everything is summed as integers
 * scaled by 10^12 and converted back once, at the end.
 */
const SCALE = 12
const toScaled = (v: unknown): bigint => {
  const s = String(v ?? '0').trim()
  if (s === '' || s === 'null') return 0n
  const neg = s.startsWith('-')
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.')
  const n = BigInt((i || '0') + f.padEnd(SCALE, '0').slice(0, SCALE))
  return neg ? -n : n
}
// 9dp is far finer than any real charge and keeps the payload compact.
const fromScaled = (b: bigint): number => Number((Number(b) / 10 ** SCALE).toFixed(9))

/* -------------------------------------------------------------- timezone -- */

/**
 * Buckets are aligned to LOCAL time, not UTC. The 12-hour buckets have to fall
 * on midnight and noon to read as AM/PM, and daily buckets on local midnight —
 * UTC alignment would put them at 10am/10pm in Sydney and split every day.
 */
export function makeZone(zone: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const cache = new Map<number, number>()

  const offsetAt = (t: number): number => {
    const key = Math.floor(t / 3_600_000)
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const p: Record<string, string> = {}
    for (const part of fmt.formatToParts(new Date(t))) {
      if (part.type !== 'literal') p[part.type] = part.value
    }
    const asUTC = Date.UTC(
      +p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second,
    )
    const off = asUTC - Math.floor(t / 1000) * 1000
    cache.set(key, off)
    return off
  }

  /**
   * Floor to a bucket boundary in local time, in two passes: the offset is
   * taken at `t`, then re-taken at the candidate boundary. On a
   * daylight-saving night those differ, and one pass lands an hour off local
   * midnight.
   */
  const floor = (t: number, size: number): number => {
    const o1 = offsetAt(t)
    let b = Math.floor((t + o1) / size) * size - o1
    const o2 = offsetAt(b)
    if (o2 !== o1) b = Math.floor((t + o2) / size) * size - o2
    return b
  }

  /** The `count` bucket starts ending with the one containing `at`. */
  const boundaries = (size: number, count: number, at: number): number[] => {
    const out = [floor(at, size)]
    while (out.length < count) out.unshift(floor(out[0] - 1, size))
    return out
  }

  /**
   * Bucket starts across the whole local days `from`..`to`, inclusive.
   *
   * Built forwards from the civil calendar rather than by stepping back a
   * bucket at a time. On the night daylight saving ends the local day is 25
   * hours long, and TWO instants an hour apart both survive the two-pass
   * floor as "midnight" — so walking backwards emitted a spurious one-hour
   * bucket, and a three-month window came out 93 bars instead of 92.
   *
   * A bucket start is the instant whose LOCAL clock reads a multiple of the
   * bucket size, which is exactly what "aligned to local midnight and noon"
   * means. On a transition day that leaves one genuinely long or short
   * bucket, which is the truth about that day.
   */
  const dayGrid = (size: number, from: Day, to: Day): number[] => {
    const out: number[] = []
    // A grain of whole days steps the calendar; anything finer divides each
    // day from its own midnight.
    const stride = size >= 86_400_000 ? Math.round(size / 86_400_000) : 1
    for (let day = from; day <= to; day = addDays(day, stride)) {
      const { y, m, d } = dayParts(day)
      const next = midnight(y, m, d + 1)
      out.push(midnight(y, m, d))
      for (let w = size; w < 86_400_000; w += size) {
        // Wall clock to instant, two passes for the same reason `floor` needs
        // two: the offset at the guess may not be the offset at the answer.
        const wall = Date.UTC(y, m - 1, d) + w
        const t = wall - offsetAt(wall - offsetAt(wall))
        if (t > out[out.length - 1] && t < next) out.push(t)
      }
    }
    return out
  }

  /**
   * Midnight beginning the local day `y-m-d`.
   *
   * Anchored on local NOON: noon is never within an hour of a daylight-saving
   * transition, so one offset lookup lands inside the right day and `floor` —
   * which re-takes the offset at the boundary — walks back to that day's true
   * midnight.
   */
  const midnight = (y: number, m: number, d: number): number => {
    const noon = Date.UTC(y, m - 1, d, 12)
    return floor(noon - offsetAt(noon), 86_400_000)
  }

  /**
   * Which `size`-sized slot of LOCAL wall-clock time `t` falls in.
   *
   * The counterpart to `dayGrid`, which places bucket starts at wall-clock
   * multiples of the size: this says which of those a row belongs to, and
   * agrees with it by construction. Exact on a transition day because the
   * offset used is the true one at `t` — where `floor` has to guess a
   * boundary and can land on one that does not exist, dropping rows in the
   * last hour of the night the clocks go back.
   *
   * Only meaningful for a size that divides a day. Whole-day grains slot by
   * day and index from there.
   */
  const slot = (t: number, size: number): number => Math.floor((t + offsetAt(t)) / size)

  /** The civil date `t` falls on, in this zone. */
  const civil = (t: number): Day => {
    const p: Record<string, string> = {}
    for (const part of fmt.formatToParts(new Date(t))) {
      if (part.type !== 'literal') p[part.type] = part.value
    }
    return dayISO(+p.year, +p.month, +p.day)
  }

  return { offsetAt, floor, boundaries, dayGrid, slot, midnight, civil }
}

/* ------------------------------------------------------------ normalise -- */

/**
 * Providers disagree about what `input` means, so normalise to three disjoint
 * buckets before anything is summed.
 *
 *   Anthropic: total = input + cached + output   (input EXCLUDES cached)
 *   OpenAI:    total = input + output            (input INCLUDES cached)
 *
 * Detected per row from the arithmetic rather than hardcoded by provider name,
 * so a new provider needs no code change. Stacking raw `input` + `cached`
 * would double-count cached tokens on OpenAI rows.
 */
function normaliseTokens(row: RawRow, warn: (m: string) => void) {
  const input = row.inputTokenCountConsumed ?? 0
  const cached = row.cachedInputTokenCountConsumed ?? 0
  const output = row.outputTokenCountConsumed ?? 0
  const total = row.totalTokenCountConsumed ?? 0
  if (input + cached + output === total) return { input, cached, output }
  if (input + output === total) return { input: Math.max(0, input - cached), cached, output }
  warn(`token counts do not reconcile for provider ${row.providerType} (model ${row.modelName})`)
  return { input, cached, output }
}

/** Write-cache charges live under provider-specific keys that change over time
 *  (5-minute and 1-hour variants already exist), so match by shape. */
function splitCharges(charges: RawRow['additionalCharges'], seen: Set<string>) {
  let write = 0n
  let other = 0n
  for (const [key, value] of Object.entries(charges ?? {})) {
    if (/writecache/i.test(key)) write += toScaled(value)
    else { other += toScaled(value); seen.add(key) }
  }
  return { write, other }
}

/* ------------------------------------------------------------ fact table -- */

export interface Facts {
  b: number[]; u: number[]; m: number[]; ex: number[]
  tIn: number[]; tCa: number[]; tOu: number[]
  cIn: number[]; cCa: number[]; cOu: number[]; cWr: number[]; cOt: number[]
}

/**
 * Totals for the window immediately before this one, of equal length and
 * non-overlapping. Kept as per-user scalars rather than a second fact table:
 * the KPI tiles only need three numbers, and the user filter only needs them
 * split by user.
 *
 * Arrays are parallel to `RangeBlock.users`.
 */
export interface PreviousWindow {
  from: number
  to: number
  spend: number[]
  tokens: number[]
  executions: number[]
}

export interface RangeBlock {
  bucketMs: number
  bucketCount: number
  zone: string
  x: number[]
  users: string[]
  models: string[]
  facts: Facts
  previous: PreviousWindow
}

/** The five presets, plus the custom window when one is selected. */
export type RangeMap = Record<RangeName, RangeBlock> & { custom?: RangeBlock }

export interface AggregateResult {
  ranges: RangeMap
  stats: {
    /** Rows fetched, before the source filter. */
    fetchedCount: number
    /** Rows kept by the source filter — what the figures are built from. */
    rowCount: number
    /** Rows on the pre-2026-06-18 convention, where `total` excludes
     *  `additionalCharges`. Reconciled, just against the older rule. */
    legacyTotals: number
    rowsPlaced: number
    amountsReconciled: number
    amountsMismatched: number
    providers: Record<string, number>
    otherChargeKeys: string[]
    warnings: string[]
  }
}

/**
 * Where a window starts and ends, on the local-time grid.
 *
 * `bounds` are the bucket starts, oldest first; `prevFrom`/`prevTo` bracket
 * the window immediately before it, of equal extent, which the KPI tiles
 * compare against. Both are WALKED on the same grid rather than computed
 * arithmetically, so a daylight-saving change cannot shift either.
 */
export interface Window {
  bounds: number[]
  prevFrom: number
  prevTo: number
}

/* ------------------------------------------------------------- grain -- */

/**
 * Bucket sizes a custom range may snap to.
 *
 * Every sub-day rung DIVIDES a day, so buckets land on local midnight
 * whatever the grain; every day-scale rung is whole days. Nothing between
 * the two (no 36-hour bucket), because a bucket that is neither a fraction
 * of a day nor a whole number of them cannot be aligned to local time at
 * all.
 */
const GRAINS = [
  15 * 60_000, 30 * 60_000,
  3_600_000, 2 * 3_600_000, 3 * 3_600_000, 4 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000,
  86_400_000, 2 * 86_400_000, 3 * 86_400_000, 4 * 86_400_000,
] as const

/** Below this a chart reads as clunky; above it the bars are hairlines. */
const BARS_MIN = 60
const BARS_MAX = 100

/**
 * The bucket size a custom span should use.
 *
 * The finest grain that keeps the bar count under `BARS_MAX` — except that
 * a grain dropping BELOW `BARS_MIN` loses to the finer one's overshoot,
 * because too few fat bars reads worse than a few too many thin ones. The
 * ladder is coarse by design, so between rungs one of the two has to give;
 * this says which.
 *
 * Measured across every span from 1 day to 1 year: 60 to 118 bars, and it
 * reproduces each preset's hand-chosen grain exactly — 1 day picks 15 min,
 * 7 days 2 hours, 14 days 4 hours, 30 days 12 hours, 90 days 1 day. A
 * custom range matching a preset therefore draws the same chart, which is
 * the property that keeps the two modes comparable.
 */
export function grainFor(spanMs: number): number {
  const bars = (g: number) => Math.ceil(spanMs / g)
  for (let i = 0; i < GRAINS.length; i++) {
    if (bars(GRAINS[i]) > BARS_MAX) continue
    return bars(GRAINS[i]) < BARS_MIN && i > 0 ? GRAINS[i - 1] : GRAINS[i]
  }
  return GRAINS[GRAINS.length - 1]
}

/** The local day a calendar window ending on `endDay` begins. */
export function calendarStartDay(endDay: Day, months: number): Day {
  // One month back from the last day, then the day after: a window ending
  // 3 April covers 4 March to 3 April, which is what "a month" means when
  // months are 28 to 31 days long.
  return addDays(addMonths(endDay, -months), 1)
}

export function windowFor(
  Z: ReturnType<typeof makeZone>,
  spec: RangeSpec,
  at: number,
): Window {
  if (!isCalendar(spec)) {
    // Twice the bars, so the older half is the immediately preceding window
    // of equal length.
    const all = Z.boundaries(spec.bucketMs, spec.count * 2, at)
    const bounds = all.slice(spec.count)
    return { bounds, prevFrom: all[0], prevTo: bounds[0] }
  }

  const startOf = (end: number): number => {
    const { y, m, d } = dayParts(calendarStartDay(Z.civil(end), spec.months))
    return Z.midnight(y, m, d)
  }
  const from = startOf(at)
  return {
    // Trimmed at `at`, so the live window stops at the bucket in progress
    // rather than running to the end of today.
    bounds: Z.dayGrid(spec.bucketMs, Z.civil(from), Z.civil(at)).filter((b) => b <= at),
    // The previous window ends the instant this one starts, and is measured
    // in the same calendar months — not in this window's own day count,
    // which would drift across a short month.
    prevFrom: startOf(from - 1),
    prevTo: from,
  }
}

/**
 * A window with both ends chosen, rather than a duration hung off an anchor.
 *
 * Whole local days only: `from` is midnight on the first day, `to` the last
 * millisecond of the last. There is deliberately no time of day — a span
 * shorter than a day is what the 24H preset is for, and a picker that
 * offered hours would make two controls answer the same question.
 */
export interface CustomSpec {
  from: number
  to: number
  bucketMs: number
}

export function customWindow(Z: ReturnType<typeof makeZone>, spec: CustomSpec): Window {
  const fromDay = Z.civil(spec.from)
  const toDay = Z.civil(spec.to)
  const bounds = Z.dayGrid(spec.bucketMs, fromDay, toDay).filter((b) => b >= spec.from && b <= spec.to)
  // The equal-length period immediately before, measured in DAYS so a
  // daylight-saving change cannot make it an hour longer than the window it
  // is being compared with.
  const days = spanDays(fromDay, toDay)
  const { y, m, d } = dayParts(addDays(fromDay, -days))
  return { bounds, prevFrom: Z.midnight(y, m, d), prevTo: spec.from }
}

const emptyFact = () => ({
  tIn: 0, tCa: 0, tOu: 0,
  cIn: 0n, cCa: 0n, cOu: 0n, cWr: 0n, cOt: 0n,
  ex: 0,
})

/**
 * One sparse fact table per range, keyed by (bucket, user, model).
 *
 * Everything the dashboard shows folds out of this: the KPI tiles, both
 * charts, and the model and user breakdowns. It has to be this shape because
 * the user filter is a real scope — filtering by user must recompute the model
 * breakdown, which a pre-aggregated per-model series could not do.
 */
export function aggregate(
  rows: readonly RawRow[],
  opts: { now: number; zone: string; source?: string | null; custom?: CustomSpec | null },
): AggregateResult {
  /*
   * The API returns every execution type — Data Source and Pipeline runs
   * outnumber Gateway calls roughly three to one — so a missing filter here
   * inflates every figure on the page. Pass `source: null` to keep them all.
   */
  const source = opts.source === undefined ? 'Gateway' : opts.source
  const scoped = source == null ? rows : rows.filter((r) => r.executionSourceType === source)
  const Z = makeZone(opts.zone)
  const warnings = new Set<string>()
  const otherChargeKeys = new Set<string>()
  const warn = (m: string) => warnings.add(m)

  const DAY = 86_400_000

  /**
   * How a row finds its bar.
   *
   * Counted ranges keep the original instant-keyed lookup, so 24H, 7D and
   * 14D are untouched. Everything built by `dayGrid` — the calendar ranges
   * and any custom window — is keyed by WALL-CLOCK SLOT instead, which is
   * how that grid defines its boundaries in the first place. The two agree
   * by construction, including on the night the clocks go back, where
   * `floor` lands on a boundary that is not in the grid and the row falls
   * through.
   */
  const placer = (bucketMs: number, w: Window, wall: boolean, until?: number) => {
    if (!wall) {
      const index = new Map(w.bounds.map((b, i) => [b, i]))
      return (t: number) => index.get(Z.floor(t, bucketMs))
    }
    const index = new Map<number, number>()
    if (bucketMs <= DAY) {
      w.bounds.forEach((b, i) => index.set(Z.slot(b, bucketMs), i))
      return (t: number) => index.get(Z.slot(t, bucketMs))
    }
    // A whole-day grain covers several civil days; each of them points at
    // the bucket it belongs to, stopping at the window's end so a row just
    // past it cannot land in the last bar.
    const stride = Math.round(bucketMs / DAY)
    w.bounds.forEach((b, i) => {
      let day = Z.civil(b)
      for (let k = 0; k < stride; k++) {
        const { y, m, d } = dayParts(day)
        const start = Z.midnight(y, m, d)
        if (until != null && start > until) break
        index.set(Z.slot(start, DAY), i)
        day = addDays(day, 1)
      }
    })
    return (t: number) => index.get(Z.slot(t, DAY))
  }

  const build = (key: string, bucketMs: number, w: Window, wall: boolean, until?: number) => ({
    key,
    bucketMs,
    bounds: w.bounds,
    prevFrom: w.prevFrom,
    prevTo: w.prevTo,
    place: placer(bucketMs, w, wall, until),
    facts: new Map<string, ReturnType<typeof emptyFact>>(),
    users: new Map<string, number>(),
    models: new Map<string, number>(),
    prev: new Map<number, { spend: bigint; tokens: number; ex: number }>(),
  })

  /* The custom window folds in the SAME pass as the presets, out of the same
     fact table. It is another window over the rows, not another pipeline —
     so everything downstream, filters and breakdowns included, works on it
     without knowing it is custom. */
  const ranges = Object.entries(RANGE_SPECS)
    .map(([key, spec]) => build(key, spec.bucketMs, windowFor(Z, spec, opts.now), isCalendar(spec)))
    .concat(opts.custom
      ? [build('custom', opts.custom.bucketMs, customWindow(Z, opts.custom), true, opts.custom.to)]
      : [])

  const providers: Record<string, number> = {}
  let reconciled = 0
  let mismatched = 0
  let legacyTotals = 0
  let placed = 0

  for (const row of scoped) {
    const t = Date.parse(row.executionDateTime)   // V8 handles the 7-digit fraction
    if (!Number.isFinite(t)) { warn('unparseable executionDateTime skipped'); continue }

    const tok = normaliseTokens(row, warn)
    const { write, other } = splitCharges(row.additionalCharges, otherChargeKeys)
    const amtIn = toScaled(row.inputTokenAmountConsumed)
    const amtCached = toScaled(row.cachedInputTokenAmountConsumed)
    const amtOut = toScaled(row.outputTokenAmountConsumed)

    /*
     * Verify the money adds up, per row — this is the contract the dashboard
     * rests on, so it is checked rather than assumed.
     *
     * There are TWO conventions. Airia changed `totalTokenAmountConsumed` on
     * 2026-06-18: before that it excluded `additionalCharges`, after it
     * includes them. A clean cutover, no overlap. Accepting only the new rule
     * flagged 65% of older rows as corrupt when they were merely older.
     *
     * Spend is summed from the COMPONENTS, never from `total`, so the figures
     * are right either way. Keep it that way — `total` is not dependable.
     */
    const parts = amtIn + amtCached + amtOut
    const charges = write + other
    const reportedTotal = toScaled(row.totalTokenAmountConsumed)
    if (parts + charges === reportedTotal) reconciled++
    else if (parts === reportedTotal) { reconciled++; legacyTotals++ }
    else mismatched++

    const provider = row.providerType ?? '(unknown)'
    providers[provider] = (providers[provider] ?? 0) + 1

    const model = row.modelName || '(unspecified)'
    const user = (row.userEmail ?? '').trim() || SERVICE_KEY
    let counted = false

    for (const r of ranges) {
      const bi = r.place(t)

      if (bi === undefined) {
        // Not in the current window. It may still be in the one before it,
        // which the KPI tiles compare against.
        if (t >= r.prevFrom && t < r.prevTo) {
          if (!r.users.has(user)) r.users.set(user, r.users.size)
          const ui = r.users.get(user)!
          let acc = r.prev.get(ui)
          if (!acc) { acc = { spend: 0n, tokens: 0, ex: 0 }; r.prev.set(ui, acc) }
          acc.spend += amtIn + amtCached + amtOut + write + other
          acc.tokens += tok.input + tok.cached + tok.output
          acc.ex += 1
        }
        continue
      }

      counted = true
      if (!r.users.has(user)) r.users.set(user, r.users.size)
      if (!r.models.has(model)) r.models.set(model, r.models.size)
      const fk = `${bi}|${r.users.get(user)}|${r.models.get(model)}`
      let f = r.facts.get(fk)
      if (!f) { f = emptyFact(); r.facts.set(fk, f) }
      f.tIn += tok.input; f.tCa += tok.cached; f.tOu += tok.output
      f.cIn += amtIn; f.cCa += amtCached; f.cOu += amtOut
      f.cWr += write; f.cOt += other
      f.ex += 1
    }
    if (counted) placed++
  }

  const out = {} as RangeMap
  for (const r of ranges) {
    const c: Facts = { b: [], u: [], m: [], ex: [], tIn: [], tCa: [], tOu: [], cIn: [], cCa: [], cOu: [], cWr: [], cOt: [] }
    for (const [fk, f] of r.facts) {
      const [b, u, m] = fk.split('|').map(Number)
      c.b.push(b); c.u.push(u); c.m.push(m); c.ex.push(f.ex)
      c.tIn.push(f.tIn); c.tCa.push(f.tCa); c.tOu.push(f.tOu)
      c.cIn.push(fromScaled(f.cIn)); c.cCa.push(fromScaled(f.cCa)); c.cOu.push(fromScaled(f.cOu))
      c.cWr.push(fromScaled(f.cWr)); c.cOt.push(fromScaled(f.cOt))
    }
    out[r.key as RangeName] = {
      bucketMs: r.bucketMs,
      // Derived, not declared: a calendar window is 56 to 62 half-days
      // depending on the month.
      bucketCount: r.bounds.length,
      zone: opts.zone,
      // Shipped rather than derived: locally-aligned buckets are not a strict
      // arithmetic grid across a daylight-saving change.
      x: r.bounds,
      users: [...r.users.keys()],
      models: [...r.models.keys()],
      facts: c,
      previous: {
        from: r.prevFrom,
        to: r.prevTo,
        spend: [...r.users.values()].map((ui) => fromScaled(r.prev.get(ui)?.spend ?? 0n)),
        tokens: [...r.users.values()].map((ui) => r.prev.get(ui)?.tokens ?? 0),
        executions: [...r.users.values()].map((ui) => r.prev.get(ui)?.ex ?? 0),
      },
    }
  }

  return {
    ranges: out,
    stats: {
      fetchedCount: rows.length,
      rowCount: scoped.length,
      legacyTotals,
      rowsPlaced: placed,
      amountsReconciled: reconciled,
      amountsMismatched: mismatched,
      providers,
      otherChargeKeys: [...otherChargeKeys],
      warnings: [...warnings],
    },
  }
}

/**
 * Earliest instant ONE STEP BACK would need.
 *
 * The window before this one, plus that window's own comparison period —
 * for 3M, nine calendar months. Worth fetching up front: stepping back is
 * the first thing anyone does after reading the live window, and without
 * these rows that click is a cache miss however much history is cached
 * behind it.
 */
export function prefetchBoundary(now: number, zone: string): number {
  const Z = makeZone(zone)
  return Math.min(...Object.values(RANGE_SPECS).map((spec) => {
    const here = windowFor(Z, spec, now)
    return windowFor(Z, spec, here.bounds[0] - 1).prevFrom
  }))
}

/**
 * Earliest instant any range needs, so one fetch covers them all.
 *
 * Reaches back twice each range's extent, because the KPI tiles compare
 * against the immediately preceding window of equal length — for 3M that is
 * six calendar months, which is 181 to 184 days depending on where in the
 * year it lands.
 */
export function earliestBoundary(now: number, zone: string): number {
  const Z = makeZone(zone)
  return Math.min(...Object.values(RANGE_SPECS).map((s) => windowFor(Z, s, now).prevFrom))
}
