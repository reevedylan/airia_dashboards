import { useEffect, useMemo, useRef, useState } from 'react'
import type { RangeKey } from '../components'
import { aggregate, earliestBoundary, SERVICE_KEY, type AggregateResult } from '../lib/airia/aggregate'
import { fetchAll, probe, AuthError, type Progress } from '../lib/airia/fetchAll'
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

export type LoadState =
  | { status: 'idle' }
  | { status: 'loading'; message: string; progress?: Progress }
  | { status: 'ready'; data: AiriaData }
  | { status: 'error'; message: string; auth?: boolean }

const ZONE = 'Australia/Sydney'

/**
 * Builds the dashboard from a pasted API key, in the browser.
 *
 * The Airia API sends no CORS headers, so the requests go to `/airia/...` on
 * this origin and a proxy forwards them — see `src/lib/airia/fetchAll.ts`.
 * Nothing is persisted: no server, no tenant data on disk, and the key lives
 * only in this tab.
 */
export function useAiriaLive(key: string | null, anchor: number | null): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'idle' })
  const run = useRef(0)
  /** Raw rows kept so a different anchor is a re-fold, not a re-fetch. */
  const cache = useRef<{ key: string; rows: RawRow[]; from: number; to: number } | null>(null)

  useEffect(() => {
    if (!key) { setState({ status: 'idle' }); cache.current = null; return }
    const token = ++run.current
    const ctrl = new AbortController()
    const live = () => token === run.current && !ctrl.signal.aborted

    ;(async () => {
      try {
        const wallNow = Date.now()
        const at = anchor ?? wallNow
        const needFrom = earliestBoundary(at, ZONE)

        if (cache.current?.key !== key) cache.current = null

        let expected = cache.current?.rows.length ?? 0
        if (!cache.current) {
          setState({ status: 'loading', message: 'Checking the key…' })
          expected = await probe(key, needFrom, wallNow)
          if (!live()) return
          setState({ status: 'loading', message: 'Fetching executions…' })
          const { rows } = await fetchAll(key, needFrom, wallNow, (p) => {
            if (live()) setState({ status: 'loading', message: 'Fetching executions…', progress: p })
          }, ctrl.signal)
          if (!live()) return
          cache.current = { key, rows, from: needFrom, to: wallNow }
        } else if (needFrom < cache.current.from) {
          // Stepped back past what is cached: fetch only the missing older
          // slice and prepend it, rather than refetching the whole span.
          const gapTo = cache.current.from
          setState({ status: 'loading', message: 'Fetching earlier executions…' })
          const { rows } = await fetchAll(key, needFrom, gapTo, (p) => {
            if (live()) setState({ status: 'loading', message: 'Fetching earlier executions…', progress: p })
          }, ctrl.signal)
          if (!live()) return
          cache.current = { key, rows: rows.concat(cache.current.rows), from: needFrom, to: cache.current.to }
        }

        const held = cache.current!
        setState({ status: 'loading', message: 'Aggregating…' })
        // Yield a frame so the message paints before a synchronous fold.
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        const agg: AggregateResult = aggregate(held.rows, { now: at, zone: ZONE, source: 'Gateway' })
        if (!live()) return

        setState({
          status: 'ready',
          data: {
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
          },
        })
      } catch (err) {
        if (!live()) return
        const auth = err instanceof AuthError
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err), auth })
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
