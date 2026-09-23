/** Scales, tick generation and density reduction. No dependencies. */

export interface LinearScale {
  (value: number): number
  invert(pixel: number): number
  domain: readonly [number, number]
  range: readonly [number, number]
}

export function linearScale(domain: readonly [number, number], range: readonly [number, number]): LinearScale {
  const [d0, d1] = domain
  const [r0, r1] = range
  const span = d1 - d0 || 1
  const fn = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as LinearScale
  fn.invert = (p: number) => d0 + ((p - r0) / (r1 - r0 || 1)) * span
  fn.domain = domain
  fn.range = range
  return fn
}

/** Round a domain out to human numbers (0 / 1,000 / 2,000) for the y-axis. */
export function niceDomain(min: number, max: number, targetTicks = 4): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (min === max) return min === 0 ? [0, 1] : [Math.min(0, min), Math.max(0, max * 1.2)]
  const step = tickStep(min, max, targetTicks)
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step]
}

function tickStep(min: number, max: number, count: number): number {
  const raw = (max - min) / Math.max(1, count)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const snapped = norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1
  return snapped * mag
}

/** Evenly spaced round values across a domain, inclusive of both ends. */
export function ticks(min: number, max: number, count = 4): number[] {
  const step = tickStep(min, max, count)
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
    out.push(Math.abs(v) < step * 1e-6 ? 0 : v)
  }
  return out
}

/* ------------------------------------------------------- band geometry -- */

export interface Band {
  /** Width of one slot, including its share of the gap. */
  step: number
  /** Painted width of a mark inside the slot. */
  width: number
  /** Left edge of slot i. */
  at(i: number): number
}

/**
 * Lay out `count` marks across `width` pixels.
 *
 * Built for density: at 300 bars in 600px the gap collapses to zero and the
 * bar floors at 1px rather than vanishing. `maxWidth` stops a handful of
 * bars from becoming slabs — the leftover stays as air.
 */
export function bandScale(count: number, width: number, gap = 2, maxWidth = 24): Band {
  const n = Math.max(1, count)
  const step = width / n
  // Give up the gap before giving up the bar.
  const usableGap = step > gap * 2.5 ? gap : step > 2 ? Math.min(gap, step - 1.5) : 0
  const painted = Math.min(maxWidth, Math.max(1, step - usableGap))
  return {
    step,
    width: painted,
    at: (i: number) => i * step + (step - painted) / 2,
  }
}

/* ----------------------------------------------------------- reduction -- */

export type Reducer = 'sum' | 'mean' | 'max' | 'last'


/** Clamp a value into a range. */
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
