/**
 * Folding the fact table into what the page draws.
 *
 * One sparse table per range, keyed by (bucket, user, model, gateway), and
 * every number on the dashboard comes out of it here: the KPI tiles, both
 * charts, all three breakdowns and the period comparison. Pure — no React
 * beyond the two option-list hooks, no network, no dates.
 */

import { useEffect, useMemo, useState } from 'react'
import type { RangeBlock } from '../lib/airia/aggregate'
import { fetchGatewayNames, type GatewayNames } from '../lib/airia/gateways'
import type { AiriaData } from './live'

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

/**
 * Which facts to include.
 *
 * Two kinds of field, and the distinction is the one CLAUDE.md draws
 * between scoping and isolating. `users` and `gateways` are SCOPES: sets
 * that narrow everything on the page, and an empty one means "all", never
 * "none". `model`, `user` and `gateway` are single-value ISOLATES, a view
 * laid on top of whatever the scopes already chose.
 */
export interface FactFilter {
  /** Selected user labels. Undefined or empty means every user. */
  users?: ReadonlySet<string>
  /** Selected gateway ids. Undefined or empty means every gateway. */
  gateways?: ReadonlySet<string>
  model?: string | null
  user?: string | null
  gateway?: string | null
}

/** The scopes alone — what recomputes the whole page, isolation aside. */
export interface Scope {
  users?: ReadonlySet<string>
  gateways?: ReadonlySet<string>
}

/** Label indices a scope admits, or null for "everything". */
function admitted(labels: readonly string[], chosen?: ReadonlySet<string>): Set<number> | null {
  if (!chosen || chosen.size === 0) return null
  return new Set(labels.map((l, i) => (chosen.has(l) ? i : -1)).filter((i) => i >= 0))
}

function predicate(block: RangeBlock, f: FactFilter): (i: number) => boolean {
  const { model, user, gateway } = f
  // Resolve labels to dictionary indices once, rather than per fact.
  const okUser = admitted(block.users, f.users)
  const okGateway = admitted(block.gateways, f.gateways)
  const mi = model == null ? -1 : block.models.indexOf(model)
  const ui = user == null ? -1 : block.users.indexOf(user)
  const gi = gateway == null ? -1 : block.gateways.indexOf(gateway)
  const facts = block.facts
  return (i) => {
    if (okUser && !okUser.has(facts.u[i])) return false
    if (okGateway && !okGateway.has(facts.g[i])) return false
    if (model != null && facts.m[i] !== mi) return false
    if (user != null && facts.u[i] !== ui) return false
    if (gateway != null && facts.g[i] !== gi) return false
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
 * Totals for the window immediately before the selected one, under the same
 * scopes — so a delta reflects that slice's change, not the tenant's.
 *
 * Walks the sparse (user, gateway) pairs rather than indexing per user: a
 * gateway filter has to narrow the baseline too, and per-user scalars could
 * not express that. Comparing a filtered window against an unfiltered
 * baseline is the exact shape of bug this avoids.
 */
export function previousTotals(block: RangeBlock, scope: Scope = {}): PeriodTotals {
  const p = block.previous
  const okUser = admitted(block.users, scope.users)
  const okGateway = admitted(block.gateways, scope.gateways)
  let spend = 0, tokens = 0, executions = 0
  for (let i = 0; i < p.u.length; i++) {
    if (okUser && !okUser.has(p.u[i])) continue
    if (okGateway && !okGateway.has(p.g[i])) continue
    spend += p.spend[i]
    tokens += p.tokens[i]
    executions += p.executions[i]
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

export type Dimension = 'model' | 'user' | 'gateway'

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

/** The dictionary and fact column a dimension reads. */
const axis = (block: RangeBlock, dim: Dimension) =>
  dim === 'model' ? { labels: block.models, idx: block.facts.m }
  : dim === 'user' ? { labels: block.users, idx: block.facts.u }
  : { labels: block.gateways, idx: block.facts.g }

/** Totals per model, user or gateway, within the current scopes. */
export function breakdown(block: RangeBlock, dim: Dimension, scope: Scope = {}): BreakdownRow[] {
  const f = block.facts
  const { labels, idx } = axis(block, dim)
  const keep = predicate(block, scope)

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

/** Every label seen for a dimension across every range, for a filter's
 *  option list — so the choices do not change as the window moves. */
function allLabels(data: AiriaData | null, pick: (b: RangeBlock) => readonly string[]): string[] {
  if (!data) return []
  const seen = new Set<string>()
  for (const block of Object.values(data.ranges)) for (const l of pick(block)) seen.add(l)
  return [...seen].sort((a, b) => a.localeCompare(b))
}

export function useAllUsers(data: AiriaData | null): string[] {
  return useMemo(() => allLabels(data, (b) => b.users), [data])
}

export function useAllGateways(data: AiriaData | null): string[] {
  return useMemo(() => allLabels(data, (b) => b.gateways), [data])
}

/**
 * Gateway names, fetched once per key, in the background.
 *
 * Deliberately outside the load state: the dashboard does not wait for it
 * and does not fail with it. Names arrive late and labels re-render; if
 * they never arrive, short ids stand in.
 */
export function useGatewayNames(key: string | null): GatewayNames {
  const [names, setNames] = useState<GatewayNames>({})
  useEffect(() => {
    if (!key) { setNames({}); return }
    const ctrl = new AbortController()
    fetchGatewayNames(key, ctrl.signal).then((n) => { if (!ctrl.signal.aborted) setNames(n) })
    return () => ctrl.abort()
  }, [key])
  return names
}
