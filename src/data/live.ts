/**
 * Fetching, caching and folding a tenant's executions in the browser.
 *
 * The dashboard builds itself from a pasted API key. Raw rows are held for
 * the life of the tab so that moving the window is a re-fold rather than a
 * re-fetch, a background pass reaches back to the retention floor, and the
 * last good fold is held on screen while the next one loads.
 *
 * Nothing is persisted: no server holds the data, none of it reaches disk,
 * and the key lives only in the tab that pasted it.
 */

import { useEffect, useRef, useState } from 'react'
import { aggregate, earliestBoundary, prefetchBoundary, SERVICE_KEY,
         type AggregateResult, type RangeMap, type RawRow } from '../lib/airia/aggregate'
import { fetchAll, probe, AuthError, BACKGROUND_CONCURRENCY, type Progress } from '../lib/airia/fetchAll'
import { ZONE, DAY_MS, RETENTION_MS, customSpec, customPrevFrom, type DayRange } from './window'

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


export interface AiriaData {
  meta: AiriaMeta
  ranges: RangeMap
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

export function useAiriaLive(
  key: string | null,
  anchor: number | null,
  custom: DayRange | null = null,
): LoadState {
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
        /* A custom window reaches wherever it was drawn, and its own
           comparison period reaches an equal span before that. */
        const spec = custom ? customSpec(custom) : null
        const customFrom = spec ? customPrevFrom(spec) : Infinity
        const needFrom = Math.max(Math.min(earliestBoundary(at, ZONE), customFrom), floor)

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
        const agg: AggregateResult = aggregate(rows, { now: at, zone: ZONE, source: 'Gateway', custom: spec })
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
          ranges: agg.ranges,
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
    // Depends on the custom range's ENDS, not its object identity, so a
    // re-render with an equal range does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, anchor, custom?.from, custom?.to])

  return state
}
