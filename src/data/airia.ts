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

/**
 * One model's per-bucket series, SPARSE: `h` holds the bucket indices where
 * the model ran and every other array is parallel to it.
 */
export interface ModelSeries {
  model: string
  h: number[]
  ex: number[]
  tIn: number[]; tCa: number[]; tOu: number[]
  cIn: number[]; cCa: number[]; cOu: number[]; cWr: number[]; cOt: number[]
}

export interface ModelRow {
  model: string
  spend: number
  /** Input + cached input. Both are prompt-side tokens the caller sent. */
  tokensIn: number
  tokensOut: number
  tokens: number
  executions: number
  /** The model's actual unit price, derived from its own cost/count per
   *  category. Stable per model, and the honest basis for comparing two. */
  inputRate: number | null
  outputRate: number | null
  /** Share of the window's totals, 0–1. */
  shareTokens: number | null
  shareSpend: number | null
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
  models: ModelSeries[]
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

/** Per-category series for one model, scattered back onto the dense grid. */
export interface ModelBreakdown {
  tokens: { input: number[]; cached: number[]; output: number[] }
  cost: { input: number[]; cached: number[]; output: number[]; write: number[]; other: number[] }
}

const dense = (n: number) => new Array<number>(n).fill(0)

export function breakdownFor(block: RangeBlock, model: string): ModelBreakdown | null {
  const s = block.models.find((m) => m.model === model)
  if (!s) return null
  const n = block.bucketCount
  const out: ModelBreakdown = {
    tokens: { input: dense(n), cached: dense(n), output: dense(n) },
    cost: { input: dense(n), cached: dense(n), output: dense(n), write: dense(n), other: dense(n) },
  }
  s.h.forEach((bucket, j) => {
    out.tokens.input[bucket] = s.tIn[j]
    out.tokens.cached[bucket] = s.tCa[j]
    out.tokens.output[bucket] = s.tOu[j]
    out.cost.input[bucket] = s.cIn[j]
    out.cost.cached[bucket] = s.cCa[j]
    out.cost.output[bucket] = s.cOu[j]
    out.cost.write[bucket] = s.cWr[j]
    out.cost.other[bucket] = s.cOt[j]
  })
  return out
}

/**
 * Model totals for the window, with each model's share of it.
 *
 * Shares are computed against the sum of the models rather than the bucket
 * series so that the percentages always add to 100 — the two agree, but
 * deriving both from one source removes any chance of them drifting apart.
 */
export function modelRows(block: RangeBlock): ModelRow[] {
  const raw = block.models.map((m) => {
    const tokensIn = sum(m.tIn) + sum(m.tCa)
    const tokensOut = sum(m.tOu)
    const inT = sum(m.tIn)
    const inC = sum(m.cIn)
    const ouC = sum(m.cOu)
    return {
      model: m.model,
      spend: inC + sum(m.cCa) + ouC + sum(m.cWr) + sum(m.cOt),
      tokensIn,
      tokensOut,
      tokens: tokensIn + tokensOut,
      executions: sum(m.ex),
      // Unit price per category. Never blend these: a blended rate ranks
      // models by cache hit rate rather than by price.
      inputRate: inT > 0 ? (inC / inT) * 1_000_000 : null,
      outputRate: sum(m.tOu) > 0 ? (ouC / sum(m.tOu)) * 1_000_000 : null,
    }
  })

  const totalTokens = raw.reduce((p, m) => p + m.tokens, 0)
  const totalSpend = raw.reduce((p, m) => p + m.spend, 0)

  return raw
    .map((m) => ({
      ...m,
      shareTokens: totalTokens > 0 ? m.tokens / totalTokens : null,
      shareSpend: totalSpend > 0 ? m.spend / totalSpend : null,
    }))
    .filter((m) => m.executions > 0)
    .sort((a, b) => b.spend - a.spend)
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
