import { useEffect, useState } from 'react'
import type { RangeKey } from '../components'

/**
 * Loads the aggregates produced by `scripts/ingest-airia.mjs`.
 *
 * Fetched at runtime rather than imported, so the buckets stay out of the JS
 * bundle and get cached as a static asset.
 *
 * The ingest emits one block per range, already bucketed to that range's bar
 * size and count, so there is no slicing or downsampling to do here.
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
  warnings: string[]
}

export interface ModelRow {
  model: string
  spend: number
  /** Input + cached input. Both are prompt-side tokens the caller sent. */
  tokensIn: number
  tokensOut: number
  executions: number
  /** The model's actual unit price, derived from its own cost/count per
   *  category. Stable per model, and the honest basis for comparing two. */
  inputRate: number | null
  outputRate: number | null
}

export interface RangeBlock {
  bucketMs: number
  bucketCount: number
  /** IANA zone the bucket boundaries are aligned to. */
  zone: string
  /** Bucket start timestamps. Shipped rather than derived: locally-aligned
   *  buckets are not a strict arithmetic grid across a DST change. */
  x: number[]
  tokens: { input: number[]; cached: number[]; output: number[] }
  cost: { input: number[]; cached: number[]; output: number[]; write: number[]; other: number[] }
  executions: number[]
  models: ModelRow[]
}

/** Ranges the ingest produces. `Custom` is a placeholder control with no
 *  block of its own, so it falls back to the widest range. */
export type DataRangeKey = '24H' | '7D' | '14D' | '1M' | '3M'

export interface AiriaData {
  meta: AiriaMeta
  ranges: Record<DataRangeKey, RangeBlock>
}

export const dataRangeFor = (range: RangeKey): DataRangeKey =>
  (range === 'Custom' ? '3M' : range) as DataRangeKey

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

const sum = (a: readonly number[]) => a.reduce((p, c) => p + c, 0)

/**
 * Running total across the block. Starts at zero by construction, so it is
 * always "cumulative within the selected window" and resets whenever the
 * range changes — never all-time.
 */
export function runningTotal(values: readonly number[]): number[] {
  let acc = 0
  return values.map((v) => (acc += v))
}

export interface RangeSummary {
  /** Total cost per bucket. */
  paid: number[]
  /** Total tokens per bucket. */
  tokenTotals: number[]
  totals: {
    tokens: number
    cost: number
    executions: number
  }
}

export function summarise(block: RangeBlock): RangeSummary {
  const paid = block.x.map((_, i) =>
    block.cost.input[i] + block.cost.cached[i] + block.cost.output[i] +
    block.cost.write[i] + block.cost.other[i])
  const tokenTotals = block.x.map((_, i) =>
    block.tokens.input[i] + block.tokens.cached[i] + block.tokens.output[i])

  return {
    paid,
    tokenTotals,
    totals: {
      tokens: sum(tokenTotals),
      cost: sum(paid),
      executions: sum(block.executions),
    },
  }
}
