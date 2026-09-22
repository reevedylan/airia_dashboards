/**
 * Deterministic synthetic telemetry, so the demo renders identically every
 * time. Swap these functions for your API; the components only need
 * `{ x: number[], values: number[] }`.
 */

import type { RangeKey } from '../components/primitives/TimeRangeBar'

/** Mulberry32 — small, fast, seeded. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface RangeSpec {
  /** Sample interval in ms. */
  step: number
  /** Number of samples. Deliberately high — these charts are built for
   *  hundreds of marks, not seven. */
  count: number
}

export const RANGE_SPEC: Record<RangeKey, RangeSpec> = {
  '24H': { step: 60_000, count: 1_440 },       // 1 min × 24 h
  '7D': { step: 300_000, count: 2_016 },       // 5 min × 7 d
  '1M': { step: 1_800_000, count: 1_440 },     // 30 min × 30 d
  '3M': { step: 3_600_000, count: 2_160 },     // 1 h × 90 d
  Custom: { step: 3_600_000, count: 2_160 },
}

export interface Telemetry {
  x: number[]
  success: number[]
  errors: number[]
  cost: number[]
  latency: number[]
  totals: { requests: number; errors: number; cost: number; latency: number }
}

export function buildTelemetry(range: RangeKey, endAt: number): Telemetry {
  const { step, count } = RANGE_SPEC[range]
  const rand = rng(range.length * 7919 + count)

  const x: number[] = []
  const success: number[] = []
  const errors: number[] = []
  const cost: number[] = []
  const latency: number[] = []

  // Slow drift + daily cycle + spikes: enough structure that the shape is
  // worth looking at, and enough noise to stress the density reduction.
  let drift = 0
  let lat = 6.0
  for (let i = 0; i < count; i++) {
    const t = endAt - (count - 1 - i) * step
    const dayPhase = ((t % 86_400_000) / 86_400_000) * Math.PI * 2
    drift += (rand() - 0.5) * 0.06
    drift = Math.max(-1, Math.min(1, drift))

    const base = 1 + 0.35 * Math.sin(dayPhase) + drift * 0.3
    const spike = rand() > 0.972 ? 1.6 + rand() * 2.4 : 0
    const s = Math.max(0, (base + spike) * (900 + rand() * 260))

    const errRate = 0.004 + (rand() > 0.988 ? 0.06 + rand() * 0.1 : 0)
    lat += (rand() - 0.5) * 0.55
    lat = Math.max(1.6, Math.min(11, lat * 0.985 + 6.0 * 0.015))

    x.push(t)
    success.push(Math.round(s))
    errors.push(Math.round(s * errRate))
    cost.push(Number((s * (0.022 + rand() * 0.012)).toFixed(4)))
    latency.push(Number(lat.toFixed(3)))
  }

  const sum = (a: number[]) => a.reduce((p, c) => p + c, 0)
  return {
    x, success, errors, cost, latency,
    totals: {
      requests: sum(success) + sum(errors),
      errors: sum(errors),
      cost: sum(cost),
      latency: sum(latency) / latency.length,
    },
  }
}

/* --------------------------------------------------------- dimensions -- */

export const MODELS = [
  { key: 'gpt-4-1106-vision-preview', label: 'gpt-4-1106-vision-preview', value: 1_423_419 },
  { key: 'gpt-4-vision-preview', label: 'gpt-4-vision-preview', value: 794_467 },
  { key: 'gpt-4', label: 'gpt-4', value: 562_747 },
  { key: 'gpt-4-0125-preview', label: 'gpt-4-0125-preview', value: 297_925 },
  { key: 'gpt-4-turbo-preview', label: 'gpt-4-turbo-preview', value: 132_411 },
  { key: 'gpt-3.5-turbo-1106', label: 'gpt-3.5-turbo-1106', value: 99_308 },
  { key: 'gpt-3.5-turbo', label: 'gpt-3.5-turbo', value: 61_204 },
  { key: 'text-embedding-3-large', label: 'text-embedding-3-large', value: 28_755 },
  { key: 'text-embedding-3-small', label: 'text-embedding-3-small', value: 12_090 },
]

export const COUNTRIES = [
  { key: 'US', label: 'United States (US)', glyph: '🇺🇸', value: 4_389 },
  { key: 'ID', label: 'Indonesia (ID)', glyph: '🇮🇩', value: 2_948 },
  { key: 'IN', label: 'India (IN)', glyph: '🇮🇳', value: 2_317 },
  { key: 'PH', label: 'Philippines (PH)', glyph: '🇵🇭', value: 1_919 },
  { key: 'GB', label: 'United Kingdom (GB)', glyph: '🇬🇧', value: 1_197 },
  { key: 'DE', label: 'Germany (DE)', glyph: '🇩🇪', value: 986 },
  { key: 'BR', label: 'Brazil (BR)', glyph: '🇧🇷', value: 764 },
  { key: 'JP', label: 'Japan (JP)', glyph: '🇯🇵', value: 512 },
]

/** Error codes, scaled to whatever the selected range produced. */
export function errorBreakdown(total: number) {
  const mix = [
    { key: '500', label: '500 Server error', share: 0.63 },
    { key: '400', label: '400 Bad request', share: 0.29 },
    { key: '401', label: '401 Unauthorized', share: 0.08 },
  ]
  return mix.map((m) => ({ ...m, value: Math.round(total * m.share) }))
}
