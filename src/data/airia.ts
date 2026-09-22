import { useEffect, useMemo, useState } from 'react'
import type { RangeKey } from '../components'

/**
 * Loads the aggregates produced by `scripts/ingest-airia.mjs`.
 *
 * Each range ships one sparse fact table keyed by (bucket, user, model), and
 * everything on the page is folded out of it here: the KPI tiles, both charts,
 * and the model and user breakdowns.
 *
 * It has to work this way because the user filter is a real scope rather than
 * a highlight — filtering by user must recompute the model breakdown too,
 * which a pre-aggregated per-model series could not do. The tables stay small
 * (about a thousand facts across all five ranges) so folding on every render
 * is cheaper than shipping the pre-aggregations would be.
 */

export interface AiriaMeta {
  generatedAt: string
  now: number
  from: number
  to: number
  source: string
  zone: string
  rowCount: number
  rowsPlaced: number
  rangeTotalCount: number
  windowSplits: number
  providers: Record<string, number>
  otherChargeKeys: string[]
  amountsReconciled: number
  amountsMismatched: number
  /** Label used for traffic with no user on the row. */
  unattributedLabel: string
  warnings: string[]
}

/** Column-oriented facts. Every array is the same length; index i is one
 *  (bucket, user, model) combination that actually occurred. */
export interface Facts {
  b: number[]
  u: number[]
  m: number[]
  ex: number[]
  tIn: number[]; tCa: number[]; tOu: number[]
  cIn: number[]; cCa: number[]; cOu: number[]; cWr: number[]; cOt: number[]
}

export interface RangeBlock {
  bucketMs: number
  bucketCount: number
  /** IANA zone the bucket boundaries are aligned to. */
  zone: string
  /** Bucket start timestamps. Shipped rather than derived: locally-aligned
   *  buckets are not a strict arithmetic grid across a DST change. */
  x: number[]
  /** Dimension dictionaries; `facts.u` and `facts.m` index into these. */
  users: string[]
  models: string[]
  facts: Facts
}

export interface AiriaData {
  meta: AiriaMeta
  ranges: Record<RangeKey, RangeBlock>
}

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: AiriaData }
  | { status: 'missing' }
  | { status: 'error'; message: string }

export function useAiria(url = 'data/airia-gateway.json'): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    let alive = true
    fetch(url)
      .then(async (res) => {
        // A gitignored data file simply isn't there on a fresh clone; that is
        // an expected state with its own empty view, not an error.
        if (res.status === 404) return { status: 'missing' as const }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return { status: 'ready' as const, data: (await res.json()) as AiriaData }
      })
      .then((next) => { if (alive) setState(next) })
      .catch((err) => { if (alive) setState({ status: 'error', message: String(err.message ?? err) }) })
    return () => { alive = false }
  }, [url])

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
