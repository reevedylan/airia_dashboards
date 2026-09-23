import { useEffect, useMemo, useRef, useState } from 'react'
import type { RangeKey } from '../components'
import {
  aggregate, earliestBoundary, prefetchBoundary, isCalendar, makeZone, calendarStartDay,
  RANGE_SPECS, SERVICE_KEY, type AggregateResult,
} from '../lib/airia/aggregate'
import { addDays, addMonths, type Day } from '../lib/day'
import { fetchAll, probe, AuthError, BACKGROUND_CONCURRENCY, type Progress } from '../lib/airia/fetchAll'
import type { RawRow } from '../lib/airia/aggregate'

/**
 * Builds the dashboard in the browser from a pasted API key.
 *
 * Each range is one sparse fact table keyed by (bucket, user, model), and
 * everything on the page is folded out of it here: the KPI tiles, both charts,
 * and the model and user breakdowns.
 *
 * It has to work this way because the user filter is a real scope rather than
 * a highlight — filtering by user must recompute the model breakdown too,
 * which a pre-aggregated per-model series could not do. The tables stay small
 * (about a thousand facts across all five ranges) so folding on every render
 * is cheaper than pre-aggregating would be.
 *
 * Nothing is persisted: no server holds the data, none of it reaches disk, and
 * the key lives only in the tab that pasted it.
 */

export interface AiriaMeta {
  generatedAt: string
  now: number
  from: number
  to: number
  source: string
  zone: string
  /** False when the window is anchored in the past rather than ending now. */
  live: boolean
  /** Rows kept by the source filter — what the figures are built from. */
  rowCount: number
  /** Rows fetched, before the source filter. */
  fetchedCount: number
  /** Rows reconciled against the pre-2026-06-18 total convention. */
  legacyTotals: number
  rowsPlaced: number
  rangeTotalCount: number
  windowSplits: number
  providers: Record<string, number>
  otherChargeKeys: string[]
  amountsReconciled: number
  amountsMismatched: number
  /** Label for requests made with the tenant's standard service key rather
   *  than an individual user's. */
  serviceKeyLabel: string
  warnings: string[]
}

export type { Facts, RangeBlock, PreviousWindow } from '../lib/airia/aggregate'
import type { RangeBlock } from '../lib/airia/aggregate'

export interface AiriaData {
  meta: AiriaMeta
  ranges: Record<RangeKey, RangeBlock>
}

/**
 * What the dashboard has to show right now.
 *
 * `data` is the last successful fold and is HELD across a refetch, which is
 * the whole point of the shape. An earlier version made this a discriminated
 * union on status, so every non-ready state had no data and the page fell
 * back to the key gate — including a mid-session backfill, which made
 * stepping the window past the cached span look like being logged out.
 * Only `auth` should ever send someone back to the gate.
 */
export interface LoadState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** The most recent successful fold. Null only before the first one. */
  data: AiriaData | null
  /** What is happening, while loading; what went wrong, on error. */
  message?: string
  progress?: Progress
  /** The key itself was rejected. The one error the gate should answer. */
  auth?: boolean
  /** How far back the raw-row cache reaches, and where it is heading. */
  history?: History
}

/** Progress of the background reach into older history. */
export interface History {
  /** Oldest instant currently held. */
  from: number
  /** Oldest instant worth holding — the platform's retention floor. */
  target: number
  /** True while the backfill is still working towards `target`. */
  running: boolean
  /** Raw rows held. */
  rows: number
}

const ZONE = 'Australia/Sydney'
const DAY_MS = 86_400_000
/** Offsets are cached inside, so one instance for the life of the module. */
const Z = makeZone(ZONE)

/**
 * Platform retention is a year. Airia's logs expire at 365 days, so that is
 * a hard floor on three separate things: how far back a window may be
 * SELECTED, how far the background backfill reaches, and how far a fetch
 * will ask for. Past it there is nothing to find, and a window that reached
 * there would quietly show a partly-empty span as if it were real.
 */
export const RETENTION_DAYS = 365
const RETENTION_MS = RETENTION_DAYS * DAY_MS

/** The oldest instant the source still holds. */
export const retentionFloor = (): number => Date.now() - RETENTION_MS

/**
 * How much older history one background step fetches.
 *
 * Ninety days, which is not arbitrary: the first slice is then exactly what
 * ONE STEP BACK on the widest range needs, so the most likely next click
 * stops costing a fetch after the first wave rather than after the whole
 * year has landed. It also fills a wave of parallel requests.
 *
 * It is no longer sized to bound how long a foreground fetch waits behind
 * it — that wait is gone, because the foreground aborts the slice in flight
 * and an abort is no longer retried. What a slice still costs is the work
 * thrown away when that happens, so it is not unbounded either.
 */
const BACKFILL_SLICE_MS = 90 * DAY_MS

/* ------------------------------------------------------------ local days -- */

const isoDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
})

/** The local day containing `t`, as `YYYY-MM-DD` in the data's zone. */
export function dayOf(t: number): string {
  return isoDay.format(new Date(t))
}

/**
 * The LAST INSTANT of a local day — one millisecond before midnight.
 *
 * That is what a window anchor means: the last moment included, not the
 * first moment excluded. Anchoring on the next midnight instead puts that
 * midnight inside the bucket the fold walks back from, so picking the 10th
 * drew a final, empty bar for the 11th.
 *
 * Midnight is a boundary every bucket size divides, so a window that ends
 * here lands on the same grid the bars do whichever range is selected: on
 * 3M the last bar is that whole day, on 1M its PM half, on 24H its last
 * quarter hour.
 */
export function endOfDay(day: Day): number {
  const [y, m, d] = day.split('-').map(Number)
  return Z.midnight(y, m, d + 1) - 1
}

/**
 * Move a window anchor by `ms`, keeping it on the local-day grid if it was
 * already there.
 *
 * Plain arithmetic drifts a window by an hour across a daylight-saving
 * change, which on a 2-hour bucket is a visibly different last bar. A live
 * anchor is an arbitrary instant and is left alone.
 */
function slideAnchor(from: number, ms: number): number {
  const to = from + ms
  // Anchors sit on the last millisecond of a day, so test the boundary that
  // follows them.
  if (Z.floor(from + 1, DAY_MS) !== from + 1) return to
  const end = to + 1
  const below = Z.floor(end, DAY_MS)
  // The next local midnight: 36 hours on lands inside the following day
  // whether it is 23, 24 or 25 hours long.
  const above = Z.floor(below + DAY_MS + DAY_MS / 2, DAY_MS)
  return (end - below <= above - end ? below : above) - 1
}

/** How many whole days a fixed-count range spans. */
const spanDays = (range: RangeKey): number => {
  const spec = RANGE_SPECS[range]
  return isCalendar(spec) ? 0 : (spec.count * spec.bucketMs) / DAY_MS
}

/**
 * The oldest day a window of this range may END on.
 *
 * Chosen so the window itself starts no earlier than the retention floor:
 * the bound is on the whole span, not just on the date you click, because a
 * 3M window ending one day inside retention would still be two-thirds
 * empty.
 */
export function oldestEndDay(range: RangeKey): Day {
  const floor = dayOf(retentionFloor())
  const spec = RANGE_SPECS[range]
  return isCalendar(spec)
    // The inverse of calendarStartDay: the end day whose window starts here.
    ? addDays(addMonths(floor, spec.months), -1)
    : addDays(floor, spanDays(range) - 1)
}

/** Clamp an anchor into the selectable range — used when the range changes
 *  under an anchor that was legal for the old one. */
export function clampAnchor(range: RangeKey, anchor: number | null): number | null {
  if (anchor == null) return null
  return Math.max(anchor, endOfDay(oldestEndDay(range)))
}

/**
 * Move the window one step, in the range's OWN units.
 *
 * A calendar range steps by calendar months, so stepping back from a window
 * ending 3 April lands on one ending 3 March — contiguous with it, and
 * still a whole month. Stepping a fixed 30 days instead would walk the
 * window off the calendar a little further every month. Returns null for
 * the live window.
 */
export function stepWindow(range: RangeKey, from: number | null, dir: -1 | 1): number | null {
  const spec = RANGE_SPECS[range]
  const at = from ?? Date.now()
  const next = isCalendar(spec)
    ? endOfDay(addMonths(dayOf(at), dir * spec.months))
    : slideAnchor(at, dir * spec.count * spec.bucketMs)
  if (next >= Date.now()) return null
  return clampAnchor(range, next)
}

/** The first day of the window a given range would show ending on `day`. */
export function windowStartDay(range: RangeKey, day: Day): Day {
  const spec = RANGE_SPECS[range]
  return isCalendar(spec) ? calendarStartDay(day, spec.months) : addDays(day, -(spanDays(range) - 1))
}

/**
 * The rows between two instants.
 *
 * The cache is ascending by construction — each fetch returns its windows in
 * order and older slices are prepended whole — so these are binary searches,
 * not a scan. It matters: it keeps a fold proportional to the window being
 * shown rather than to the whole year that may be cached around it. Trimming
 * the NEWER end matters too once the window is anchored in the past: those
 * rows land in no bucket, but they were still being walked, five ranges
 * deep, and they inflate the row counts the footer reconciles.
 */
function rowsBetween(rows: readonly RawRow[], from: number, to: number): readonly RawRow[] {
  const seek = (t: number) => {
    let lo = 0
    let hi = rows.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (Date.parse(rows[mid].executionDateTime) < t) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const start = seek(from)
  const end = seek(to)
  return start === 0 && end === rows.length ? rows : rows.slice(start, end)
}

/**
 * Builds the dashboard from a pasted API key, in the browser.
 *
 * The Airia API sends no CORS headers, so the requests go to `/airia/...` on
 * this origin and a proxy forwards them — see `src/lib/airia/fetchAll.ts`.
 * Nothing is persisted: no server, no tenant data on disk, and the key lives
 * only in this tab.
 */
export function useAiriaLive(key: string | null, anchor: number | null): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'idle', data: null })
  const run = useRef(0)
  /** Raw rows kept so a different anchor is a re-fold, not a re-fetch. */
  const cache = useRef<{ key: string; rows: RawRow[]; from: number; to: number } | null>(null)
  /** The last good fold, held under a refetch so the page never goes blank. */
  const held = useRef<AiriaData | null>(null)
  /**
   * One writer at a time. The foreground fold and the background backfill
   * both extend the same array, and two overlapping fetches would prepend
   * the same rows twice and double every figure on the page.
   */
  const gate = useRef<Promise<unknown>>(Promise.resolve())
  /** The backfill slice in flight, and how far back it reaches. The reach
   *  matters: it decides whether cutting in front of it would help or
   *  would throw away the very rows being waited for. */
  const bg = useRef<{ ctrl: AbortController; from: number } | null>(null)

  useEffect(() => {
    if (!key) {
      setState({ status: 'idle', data: null })
      cache.current = null
      held.current = null
      bg.current?.ctrl.abort()
      return
    }

    const token = ++run.current
    const ctrl = new AbortController()
    const live = () => token === run.current && !ctrl.signal.aborted

    /** Serialise everything that touches the cache. */
    const exclusive = <T,>(fn: () => Promise<T>): Promise<T> => {
      const next = gate.current.then(fn, fn)
      gate.current = next.catch(() => {})
      return next
    }

    const history = (running: boolean): History => ({
      from: cache.current?.from ?? Date.now(),
      target: Date.now() - RETENTION_MS,
      running,
      rows: cache.current?.rows.length ?? 0,
    })

    const show = (patch: Partial<LoadState>) =>
      setState({ status: 'loading', data: held.current, history: history(true), ...patch })

    ;(async () => {
      try {
        /* Say so BEFORE taking the cache lock. This call may have to wait
           for an in-flight backfill slice to fold, and a window that has
           visibly changed while the page still shows the old one, with no
           indication anything is happening, reads as a freeze. */
        show({ message: 'Updating…' })
        const wallNow = Date.now()
        const at = anchor ?? wallNow
        /* What THIS view needs, and no more. Reaching further here so that
           the next click is cheap only moves the wait: every step would
           then prefetch the step after it, and the render would sit behind
           rows it is not going to draw. Depth beyond this is the
           background's job. Never past what the source keeps, either —
           near the oldest selectable window the comparison period runs off
           the end of retention, and asking for it fetches months of
           nothing. */
        const floor = wallNow - RETENTION_MS
        const needFrom = Math.max(earliestBoundary(at, ZONE), floor)

        if (cache.current?.key !== key) {
          cache.current = null
          held.current = null
        }

        /*
         * Cut in front of the backfill — but only when doing so helps.
         *
         * A slice already reaching at least as far back as this view needs
         * is fetching exactly the rows being waited for, and an aborted
         * slice is discarded whole. Killing it meant re-requesting the same
         * ninety days in the foreground: the first step back after a load
         * paid twice for one fetch.
         */
        if (bg.current && bg.current.from > needFrom) bg.current.ctrl.abort()

        let expected = cache.current?.rows.length ?? 0
        /*
         * Only take the cache lock to WRITE. A window whose rows are already
         * held needs no fetch, and queueing it behind an in-flight backfill
         * slice made an instant re-fold wait seconds for history it was not
         * going to read. Reading while the backfill writes is safe: a slice
         * lands by replacing the array, never by mutating the one in hand.
         */
        const covered = () => cache.current != null && cache.current.from <= needFrom
        if (!covered()) await exclusive(async () => {
          if (!live() || covered()) return
          if (!cache.current) {
            show({ message: 'Checking the key…' })
            expected = await probe(key, needFrom, wallNow)
            if (!live()) return
            show({ message: 'Fetching executions…' })
            const { rows } = await fetchAll(key, needFrom, wallNow, {
              onProgress: (p) => { if (live()) show({ message: 'Fetching executions…', progress: p }) },
              signal: ctrl.signal,
            })
            if (!live()) return
            cache.current = { key, rows, from: needFrom, to: wallNow }
          } else if (needFrom < cache.current.from) {
            // Stepped back past what is cached: fetch only the missing older
            // slice and prepend it, rather than refetching the whole span.
            const gapTo = cache.current.from
            show({ message: 'Fetching earlier executions…' })
            const { rows } = await fetchAll(key, needFrom, gapTo, {
              onProgress: (p) => { if (live()) show({ message: 'Fetching earlier executions…', progress: p }) },
              signal: ctrl.signal,
            })
            if (!live()) return
            cache.current = { key, rows: rows.concat(cache.current.rows), from: needFrom, to: cache.current.to }
          }
        })
        if (!live()) return

        /* One bucket past the anchor: the widest bucket is a day, and the
           one containing `at` may end after it. */
        const rows = rowsBetween(cache.current!.rows, needFrom, at + DAY_MS)
        show({ message: 'Aggregating…' })
        // Yield a frame so the message paints before a synchronous fold.
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        const agg: AggregateResult = aggregate(rows, { now: at, zone: ZONE, source: 'Gateway' })
        if (!live()) return

        held.current = {
          meta: {
            generatedAt: new Date().toISOString(),
            now: at, from: needFrom, to: at,
            /** True when the window ends at the wall clock rather than an anchor. */
            live: anchor == null,
            source: 'Gateway',
            zone: ZONE,
            rowCount: agg.stats.rowCount,
            fetchedCount: agg.stats.fetchedCount,
            legacyTotals: agg.stats.legacyTotals,
            rowsPlaced: agg.stats.rowsPlaced,
            rangeTotalCount: expected,
            windowSplits: 0,
            providers: agg.stats.providers,
            otherChargeKeys: agg.stats.otherChargeKeys,
            amountsReconciled: agg.stats.amountsReconciled,
            amountsMismatched: agg.stats.amountsMismatched,
            serviceKeyLabel: SERVICE_KEY,
            warnings: agg.stats.warnings,
          },
          ranges: agg.ranges as AiriaData['ranges'],
        }
        setState({ status: 'ready', data: held.current, history: history(cache.current!.from > floor) })

        /*
         * Reach back towards the retention floor in the background.
         *
         * Not folded into the first load: a year is 320k rows against 156k
         * for the 180 days the ranges themselves need, and making everyone
         * wait four times as long for a window most sessions never open is
         * the wrong trade. This costs nothing anybody is watching, and once
         * it lands, stepping back is a re-fold rather than a fetch.
         */
        /* The first thing to reach for is whatever ONE STEP BACK needs —
           the window before this one plus its own comparison period. That
           is the click people actually make next, and until those rows land
           it is a cache miss however much older history is already held. */
        const firstStop = Math.max(prefetchBoundary(at, ZONE), floor)
        while (live() && cache.current && cache.current.from > floor) {
          const to = cache.current.from
          const from = to > firstStop
            ? firstStop
            : Math.max(floor, to - BACKFILL_SLICE_MS)
          const slice = new AbortController()
          bg.current = { ctrl: slice, from }
          try {
            await exclusive(async () => {
              // The foreground may have moved the cache while this waited.
              if (!live() || slice.signal.aborted || !cache.current || cache.current.from <= from) return
              const { rows } = await fetchAll(key, from, cache.current.from, {
                signal: slice.signal,
                concurrency: BACKGROUND_CONCURRENCY,
              })
              /*
               * Commit on the KEY, not on liveness.
               *
               * These rows are valid history for this tenant whoever is
               * waiting for them. Discarding them because the anchor moved
               * while they were in flight was the expensive mistake: the
               * click waited three seconds for this slice, the slice threw
               * its answer away, and the foreground then fetched the very
               * same span again. Liveness governs what is on SCREEN; it has
               * no bearing on whether a fetched row is true.
               */
              if (slice.signal.aborted || cache.current?.key !== key || cache.current.from <= from) return
              cache.current = {
                ...cache.current,
                rows: rows.concat(cache.current.rows),
                from,
              }
            })
          } catch {
            // A failed or cut-short slice is not worth reporting: the window
            // on screen is complete, and asking for that span again just
            // fetches it in the foreground.
            break
          }
          if (!live()) return
          if (slice.signal.aborted) return
          bg.current = null
          setState((prev) => ({ ...prev, history: history(cache.current!.from > floor) }))
        }
        bg.current = null
        if (live()) setState((prev) => ({ ...prev, history: history(false) }))
      } catch (err) {
        if (!live()) return
        const auth = err instanceof AuthError
        setState({
          status: 'error',
          data: auth ? null : held.current,
          message: err instanceof Error ? err.message : String(err),
          auth,
          history: history(false),
        })
      }
    })()

    return () => { ctrl.abort() }
  }, [key, anchor])

  return state
}

/* ------------------------------------------------------------- folding -- */

export interface Series {
  tokens: { input: number[]; cached: number[]; output: number[] }
  cost: { input: number[]; cached: number[]; output: number[]; write: number[]; other: number[] }
  executions: number[]
  /** Per-bucket sums of the above, for the cumulative views and the ghost. */
  tokenTotals: number[]
  paid: number[]
  totals: {
    tokens: number
    tokensInput: number
    tokensCached: number
    tokensOutput: number
    cost: number
    executions: number
  }
}

const zeros = (n: number) => new Array<number>(n).fill(0)

/** Which facts to include. Any field left out is not constrained. */
export interface FactFilter {
  /** Selected user labels. Undefined or empty means every user. */
  users?: ReadonlySet<string>
  model?: string | null
  user?: string | null
}

function predicate(block: RangeBlock, f: FactFilter): (i: number) => boolean {
  const { users, model, user } = f
  const scopeAll = !users || users.size === 0
  // Resolve labels to dictionary indices once, rather than per fact.
  const allowed = scopeAll ? null : new Set(
    block.users.map((u, i) => (users!.has(u) ? i : -1)).filter((i) => i >= 0),
  )
  const mi = model == null ? -1 : block.models.indexOf(model)
  const ui = user == null ? -1 : block.users.indexOf(user)
  const facts = block.facts
  return (i) => {
    if (allowed && !allowed.has(facts.u[i])) return false
    if (model != null && facts.m[i] !== mi) return false
    if (user != null && facts.u[i] !== ui) return false
    return true
  }
}

export function seriesFor(block: RangeBlock, filter: FactFilter = {}): Series {
  const n = block.bucketCount
  const f = block.facts
  const keep = predicate(block, filter)

  const out: Series = {
    tokens: { input: zeros(n), cached: zeros(n), output: zeros(n) },
    cost: { input: zeros(n), cached: zeros(n), output: zeros(n), write: zeros(n), other: zeros(n) },
    executions: zeros(n),
    tokenTotals: zeros(n),
    paid: zeros(n),
    totals: { tokens: 0, tokensInput: 0, tokensCached: 0, tokensOutput: 0, cost: 0, executions: 0 },
  }

  for (let i = 0; i < f.b.length; i++) {
    if (!keep(i)) continue
    const b = f.b[i]
    out.tokens.input[b] += f.tIn[i]
    out.tokens.cached[b] += f.tCa[i]
    out.tokens.output[b] += f.tOu[i]
    out.cost.input[b] += f.cIn[i]
    out.cost.cached[b] += f.cCa[i]
    out.cost.output[b] += f.cOu[i]
    out.cost.write[b] += f.cWr[i]
    out.cost.other[b] += f.cOt[i]
    out.executions[b] += f.ex[i]
  }

  for (let b = 0; b < n; b++) {
    out.tokenTotals[b] = out.tokens.input[b] + out.tokens.cached[b] + out.tokens.output[b]
    out.paid[b] = out.cost.input[b] + out.cost.cached[b] + out.cost.output[b] +
      out.cost.write[b] + out.cost.other[b]
    out.totals.tokensInput += out.tokens.input[b]
    out.totals.tokensCached += out.tokens.cached[b]
    out.totals.tokensOutput += out.tokens.output[b]
    out.totals.cost += out.paid[b]
    out.totals.executions += out.executions[b]
  }
  out.totals.tokens = out.totals.tokensInput + out.totals.tokensCached + out.totals.tokensOutput
  return out
}

/* ---------------------------------------------------- period comparison -- */

export interface PeriodTotals {
  spend: number
  tokens: number
  executions: number
}

/**
 * Totals for the window immediately before the selected one, scoped by the
 * same user filter — so a delta reflects that user's change, not the tenant's.
 */
export function previousTotals(block: RangeBlock, users?: ReadonlySet<string>): PeriodTotals {
  const p = block.previous
  const all = !users || users.size === 0
  let spend = 0, tokens = 0, executions = 0
  for (let i = 0; i < block.users.length; i++) {
    if (!all && !users!.has(block.users[i])) continue
    spend += p.spend[i] ?? 0
    tokens += p.tokens[i] ?? 0
    executions += p.executions[i] ?? 0
  }
  return { spend, tokens, executions }
}

export interface Delta {
  direction: 'up' | 'down' | 'none'
  /** "12%", or "new" when there is nothing to compare against. */
  text: string
}

/**
 * Change from `before` to `now`.
 *
 * A zero baseline has no percentage — dividing by it yields Infinity, and
 * calling it "+100%" would understate an arrival from nothing. It reports
 * "new" instead.
 */
export function delta(now: number, before: number): Delta | null {
  if (before === 0) return now === 0 ? null : { direction: 'up', text: 'new' }
  const change = (now - before) / before
  if (Math.abs(change) < 0.0005) return { direction: 'none', text: '0%' }
  const direction = change > 0 ? 'up' : 'down'

  // Past roughly tenfold a percentage stops being readable — a near-zero
  // baseline produced "21388468%", which is accurate and useless. A
  // multiplier says the same thing at a glance.
  if (now > before * 10) {
    const times = now / before
    const shown = times >= 1000
      ? `${Math.round(times / 1000).toLocaleString('en-US')}k`
      : times >= 100 ? Math.round(times).toString() : times.toFixed(1)
    return { direction, text: `${shown}\u00d7` }
  }

  const pct = Math.abs(change * 100)
  return { direction, text: `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%` }
}

/* --------------------------------------------------------- breakdowns -- */

export type Dimension = 'model' | 'user'

export interface BreakdownRow {
  key: string
  spend: number
  /** Input + cached input. Both are prompt-side tokens the caller sent. */
  tokensIn: number
  tokensOut: number
  tokens: number
  executions: number
  /**
   * Effective unit price for this row, cost over count within one category.
   *
   * Blending across MODELS is fine and is what a per-user rate means. Blending
   * across CATEGORIES is not — see CLAUDE.md. Cached input is a tenth of the
   * input rate, so mixing them ranks by cache hit rate rather than by price.
   */
  inputRate: number | null
  outputRate: number | null
  shareTokens: number | null
  shareSpend: number | null
}

/** Totals per model or per user, within the current user scope. */
export function breakdown(block: RangeBlock, dim: Dimension, users?: ReadonlySet<string>): BreakdownRow[] {
  const f = block.facts
  const labels = dim === 'model' ? block.models : block.users
  const idx = dim === 'model' ? f.m : f.u
  const keep = predicate(block, { users })

  const acc = labels.map(() => ({
    spend: 0, tIn: 0, tCa: 0, tOu: 0, cIn: 0, cOu: 0, ex: 0,
  }))

  for (let i = 0; i < f.b.length; i++) {
    if (!keep(i)) continue
    const a = acc[idx[i]]
    a.spend += f.cIn[i] + f.cCa[i] + f.cOu[i] + f.cWr[i] + f.cOt[i]
    a.tIn += f.tIn[i]; a.tCa += f.tCa[i]; a.tOu += f.tOu[i]
    a.cIn += f.cIn[i]; a.cOu += f.cOu[i]
    a.ex += f.ex[i]
  }

  const rows = labels.map((key, i) => {
    const a = acc[i]
    const tokensIn = a.tIn + a.tCa
    return {
      key,
      spend: a.spend,
      tokensIn,
      tokensOut: a.tOu,
      tokens: tokensIn + a.tOu,
      executions: a.ex,
      inputRate: a.tIn > 0 ? (a.cIn / a.tIn) * 1_000_000 : null,
      outputRate: a.tOu > 0 ? (a.cOu / a.tOu) * 1_000_000 : null,
    }
  }).filter((r) => r.executions > 0)

  const totalTokens = rows.reduce((p, r) => p + r.tokens, 0)
  const totalSpend = rows.reduce((p, r) => p + r.spend, 0)

  return rows
    .map((r) => ({
      ...r,
      shareTokens: totalTokens > 0 ? r.tokens / totalTokens : null,
      shareSpend: totalSpend > 0 ? r.spend / totalSpend : null,
    }))
    .sort((a, b) => b.spend - a.spend)
}

/**
 * Running total across the block. Starts at zero by construction, so it is
 * always "cumulative within the selected window" and resets whenever the
 * range changes — never all-time.
 */
export function runningTotal(values: readonly number[]): number[] {
  let acc = 0
  return values.map((v) => (acc += v))
}

/** Every user seen across every range, for the filter's option list. */
export function useAllUsers(data: AiriaData | null): string[] {
  return useMemo(() => {
    if (!data) return []
    const seen = new Set<string>()
    for (const block of Object.values(data.ranges)) for (const u of block.users) seen.add(u)
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [data])
}
