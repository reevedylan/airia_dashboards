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
  byModel: Array<{ model: string; tokens: number; cost: number; costTokens: number; executions: number }>
  byModelHourly: {
    hour0: number
    hourCount: number
    models: string[]
    tokens: Record<string, number[]>
    cost: Record<string, number[]>
    /** Cost of counted tokens only — excludes write-cache and other charges
     *  that carry no token count, so a $/M rate stays comparable. */
    costTokens: Record<string, number[]>
    executions: Record<string, number[]>
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
  /** Ratio per bucket, `null` where the bucket had no requests at all —
   *  a share of nothing is undefined, not zero. */
  cacheHitRate: (number | null)[]
  models: Array<{ model: string; tokens: number; cost: number; costTokens: number; executions: number }>
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
  }
}

const sum = (a: readonly number[]) => a.reduce((p, c) => p + c, 0)

/**
 * Minimum input+cached tokens in a bucket before a cache-hit rate is
 * considered meaningful. One real inference request clears this comfortably.
 */
export const MIN_RATE_DENOMINATOR = 1_000

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

  const cacheHitRate = executions.map((n, i) => {
    if (n === 0) return null
    const denom = tokens.input[i] + tokens.cached[i]
    // A ratio over a handful of tokens is noise, not a rate: an 8-token probe
    // with no cache read is a true 0% that says nothing about cache health,
    // yet it plots identically to a sustained cache miss. Below the floor the
    // bucket reports "no rate" and the line breaks instead of plunging.
    if (denom < MIN_RATE_DENOMINATOR) return null
    return tokens.cached[i] / denom
  })

  // Per-model figures must follow the selected range, so re-total the hourly
  // series rather than reusing the whole-ingest byModel numbers.
  const { hour0, hourCount, models: names } = data.byModelHourly
  const hStart = Math.max(0, Math.min(hourCount, Math.ceil((startTs - hour0) / 3_600_000)))
  const models = names
    .map((model) => ({
      model,
      tokens: sum(data.byModelHourly.tokens[model].slice(hStart)),
      cost: sum(data.byModelHourly.cost[model].slice(hStart)),
      costTokens: sum(data.byModelHourly.costTokens[model].slice(hStart)),
      executions: sum(data.byModelHourly.executions[model].slice(hStart)),
    }))
    .filter((m) => m.executions > 0)
    .sort((a, b) => b.cost - a.cost)

  const tokensInput = sum(tokens.input)
  const tokensCached = sum(tokens.cached)
  const tokensOutput = sum(tokens.output)

  return {
    x, tokens, cost, balanceUsed, executions, cacheHitRate, models,
    totals: {
      tokens: tokensInput + tokensCached + tokensOutput,
      tokensInput, tokensCached, tokensOutput,
      cost: sum(cost.input) + sum(cost.cached) + sum(cost.output) + sum(cost.write) + sum(cost.other),
      costWrite: sum(cost.write),
      balanceUsed: sum(balanceUsed),
      executions: sum(executions),
      cacheHitRate: tokensInput + tokensCached === 0 ? null : tokensCached / (tokensInput + tokensCached),
    },
  }
}
