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

/** Bucket size and bar count per range. Window length is count x bucketMs. */
export const RANGE_SPECS = {
  '24H': { bucketMs: 15 * 60_000, count: 96 },
  '7D': { bucketMs: 2 * 3_600_000, count: 84 },
  '14D': { bucketMs: 4 * 3_600_000, count: 84 },
  '1M': { bucketMs: 12 * 3_600_000, count: 60 },
  '3M': { bucketMs: 24 * 3_600_000, count: 90 },
} as const

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

  return { offsetAt, floor, boundaries }
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

export interface AggregateResult {
  ranges: Record<RangeName, RangeBlock>
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
  opts: { now: number; zone: string; source?: string | null },
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

  const ranges = Object.entries(RANGE_SPECS).map(([key, spec]) => {
    // Twice the bars, so the older half is the immediately preceding window
    // of equal length. Boundaries are walked, not arithmetic, so the previous
    // window lands on the same local-time grid across a DST change.
    const all = Z.boundaries(spec.bucketMs, spec.count * 2, opts.now)
    const bounds = all.slice(spec.count)
    return {
      key: key as RangeName,
      spec,
      bounds,
      prevFrom: all[0],
      prevTo: bounds[0],
      index: new Map(bounds.map((b, i) => [b, i])),
      facts: new Map<string, ReturnType<typeof emptyFact>>(),
      users: new Map<string, number>(),
      models: new Map<string, number>(),
      prev: new Map<number, { spend: bigint; tokens: number; ex: number }>(),
    }
  })

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
      const bi = r.index.get(Z.floor(t, r.spec.bucketMs))

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

  const out = {} as Record<RangeName, RangeBlock>
  for (const r of ranges) {
    const c: Facts = { b: [], u: [], m: [], ex: [], tIn: [], tCa: [], tOu: [], cIn: [], cCa: [], cOu: [], cWr: [], cOt: [] }
    for (const [fk, f] of r.facts) {
      const [b, u, m] = fk.split('|').map(Number)
      c.b.push(b); c.u.push(u); c.m.push(m); c.ex.push(f.ex)
      c.tIn.push(f.tIn); c.tCa.push(f.tCa); c.tOu.push(f.tOu)
      c.cIn.push(fromScaled(f.cIn)); c.cCa.push(fromScaled(f.cCa)); c.cOu.push(fromScaled(f.cOu))
      c.cWr.push(fromScaled(f.cWr)); c.cOt.push(fromScaled(f.cOt))
    }
    out[r.key] = {
      bucketMs: r.spec.bucketMs,
      bucketCount: r.spec.count,
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
 * Earliest instant any range needs, so one fetch covers them all.
 *
 * Twice each range's bar count, because the KPI tiles compare against the
 * immediately preceding window of equal length — for 3M that is 180 days.
 */
export function earliestBoundary(now: number, zone: string): number {
  const Z = makeZone(zone)
  return Math.min(...Object.values(RANGE_SPECS)
    .map((s) => Z.boundaries(s.bucketMs, s.count * 2, now)[0]))
}
