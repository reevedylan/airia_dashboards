import { useEffect, useState } from 'react'
import type { RangeKey } from '../components'

/**
 * Loads the aggregates produced by `scripts/ingest-airia.mjs`.
 *
 * Fetched at runtime rather than imported, so ~1MB of buckets stays out of the
 * JS bundle and gets cached as a static asset.
 */

export interface AiriaMeta {
  from: number
  to: number
  bucketMs: number
  source: string
  /** First bucket's timestamp, floored to the bucket grid. */
  from0: number
  bucketCount: number
  generatedAt: string
  rowCount: number
  rangeTotalCount: number
  windowSplits: number
  providers: Record<string, number>
  otherChargeKeys: string[]
  amountsReconciled: number
  amountsMismatched: number
  warnings: string[]
}

export interface AiriaData {
  meta: AiriaMeta
  tokens: { input: number[]; cached: number[]; output: number[] }
  cost: { input: number[]; cached: number[]; output: number[]; write: number[]; other: number[] }
  balanceUsed: number[]
  executions: number[]
  /**
   * Per-model hourly series, SPARSE: `h` holds the hour indices where the
   * model ran, and every other array is parallel to it. Counts (`*T`) and
   * costs (`*C`) stay split per category so the rate card can be computed.
   */
  byModel: {
    hour0: number
    hourCount: number
    models: Array<{
      model: string
      h: number[]
      ex: number[]
      inT: number[]; caT: number[]; ouT: number[]
      inC: number[]; caC: number[]; ouC: number[]; wrC: number[]; otC: number[]
    }>
  }
}

export const RANGE_MS: Record<RangeKey, number> = {
  '24H': 86_400_000,
  '7D': 7 * 86_400_000,
  '1M': 30 * 86_400_000,
  '3M': 90 * 86_400_000,
  Custom: Number.POSITIVE_INFINITY,
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

export interface RangeSlice {
  x: number[]
  tokens: { input: number[]; cached: number[]; output: number[] }
  cost: { input: number[]; cached: number[]; output: number[]; write: number[]; other: number[] }
  balanceUsed: number[]
  executions: number[]
  models: ModelRow[]
  /** What this traffic actually cost, per bucket. */
  paid: number[]
  /** What the same traffic would have cost with no caching at all. */
  withoutCache: number[]
  totals: {
    tokens: number
    tokensInput: number
    tokensCached: number
    tokensOutput: number
    cost: number
    costWrite: number
    balanceUsed: number
    executions: number
    cacheHitRate: number | null
    paid: number
    withoutCache: number
    saved: number
  }
}

export interface ModelRow {
  model: string
  spend: number
  tokens: number
  executions: number
  /** The model's actual unit price, derived from its own cost/count per
   *  category. Stable per model, and the honest basis for comparing two. */
  inputRate: number | null
  outputRate: number | null
  cacheShare: number | null
}

const sum = (a: readonly number[]) => a.reduce((p, c) => p + c, 0)

/**
 * Cached input is billed at exactly one tenth of the input rate, so the same
 * tokens read uncached would have cost ten times what was paid — and without
 * caching there would be no write-cache charge at all.
 */
const CACHE_READ_DISCOUNT = 10


/** Take the trailing `range` worth of buckets. The x axis is a strict
 *  arithmetic grid, so it is generated rather than stored. */
export function sliceRange(data: AiriaData, range: RangeKey): RangeSlice {
  const { from0, bucketMs, bucketCount, to } = data.meta
  const span = RANGE_MS[range]
  const startTs = Number.isFinite(span) ? to - span : from0
  const start = Math.max(0, Math.min(bucketCount - 1, Math.ceil((startTs - from0) / bucketMs)))

  const cut = <T,>(a: T[]) => a.slice(start)
  const x = Array.from({ length: bucketCount - start }, (_, i) => from0 + (start + i) * bucketMs)

  const tokens = { input: cut(data.tokens.input), cached: cut(data.tokens.cached), output: cut(data.tokens.output) }
  const cost = {
    input: cut(data.cost.input), cached: cut(data.cost.cached), output: cut(data.cost.output),
    write: cut(data.cost.write), other: cut(data.cost.other),
  }
  const executions = cut(data.executions)
  const balanceUsed = cut(data.balanceUsed)

  // Per-model figures must follow the selected range, so re-total the sparse
  // hourly series rather than reusing whole-ingest numbers.
  const { hour0, models: sparse } = data.byModel
  const hMin = Math.ceil((startTs - hour0) / 3_600_000)
  const models: ModelRow[] = sparse
    .map((m) => {
      const keep = m.h.map((h, n) => (h >= hMin ? n : -1)).filter((n) => n >= 0)
      const pick = (a: number[]) => keep.reduce((p, n) => p + a[n], 0)
      const inT = pick(m.inT), caT = pick(m.caT), ouT = pick(m.ouT)
      const inC = pick(m.inC), caC = pick(m.caC), ouC = pick(m.ouC)
      return {
        model: m.model,
        spend: inC + caC + ouC + pick(m.wrC) + pick(m.otC),
        tokens: inT + caT + ouT,
        executions: pick(m.ex),
        // Unit price per category. Never blend these: a blended rate ranks
        // models by cache hit rate rather than by price, which inverts the
        // ordering (haiku is 5x cheaper per token than opus but caches less,
        // so it blends higher).
        inputRate: inT > 0 ? (inC / inT) * 1_000_000 : null,
        outputRate: ouT > 0 ? (ouC / ouT) * 1_000_000 : null,
        cacheShare: inT + caT > 0 ? caT / (inT + caT) : null,
      }
    })
    .filter((m) => m.executions > 0)
    .sort((a, b) => b.spend - a.spend)

  const tokensInput = sum(tokens.input)
  const tokensCached = sum(tokens.cached)
  const tokensOutput = sum(tokens.output)

  const paid = x.map((_, i) =>
    cost.input[i] + cost.cached[i] + cost.output[i] + cost.write[i] + cost.other[i])
  const withoutCache = x.map((_, i) =>
    cost.input[i] + cost.cached[i] * CACHE_READ_DISCOUNT + cost.output[i] + cost.other[i])

  return {
    x, tokens, cost, balanceUsed, executions, models, paid, withoutCache,
    totals: {
      tokens: tokensInput + tokensCached + tokensOutput,
      tokensInput, tokensCached, tokensOutput,
      cost: sum(cost.input) + sum(cost.cached) + sum(cost.output) + sum(cost.write) + sum(cost.other),
      costWrite: sum(cost.write),
      balanceUsed: sum(balanceUsed),
      executions: sum(executions),
      cacheHitRate: tokensInput + tokensCached === 0 ? null : tokensCached / (tokensInput + tokensCached),
      paid: sum(paid),
      withoutCache: sum(withoutCache),
      saved: sum(withoutCache) - sum(paid),
    },
  }
}
