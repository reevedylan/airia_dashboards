/** SVG path builders for line and area marks. */

export interface Pt { x: number; y: number }

/**
 * Polyline through every point. Straight segments — no smoothing, so the path
 * never invents a value between two samples.
 *
 * A `null` entry is a genuine gap in the data and starts a new subpath, so the
 * line breaks instead of being drawn straight across the missing stretch.
 * Bridging a gap would assert a value that was never measured; dropping to
 * zero would assert one that is wrong.
 */
export function linePath(pts: readonly (Pt | null)[]): string {
  let d = ''
  let open = false
  for (const p of pts) {
    if (!p) { open = false; continue }
    d += `${open ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`
    open = true
  }
  return d
}

/** The same polyline closed down to a baseline. Each contiguous run of points
 *  is closed as its own shape, so a gap leaves a gap in the wash too. */
export function areaPath(pts: readonly (Pt | null)[], baseline: number): string {
  let d = ''
  let run: Pt[] = []
  const flush = () => {
    if (run.length === 0) return
    const first = run[0]
    const last = run[run.length - 1]
    d += linePath(run)
    d += `L${last.x.toFixed(2)},${baseline.toFixed(2)}L${first.x.toFixed(2)},${baseline.toFixed(2)}Z`
    run = []
  }
  for (const p of pts) { if (p) run.push(p); else flush() }
  flush()
  return d
}

/**
 * A bar with its data-end rounded and its baseline end square.
 * `r` is clamped so a short or narrow bar never turns into a lozenge.
 */
export function barPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0.5) return `M${x},${y}h${w}v${Math.max(h, 0.5)}h${-w}Z`
  const rr = Math.min(r, w / 2, h)
  if (rr <= 0.5) return `M${x},${y}h${w}v${h}h${-w}Z`
  return `M${x},${y + rr}a${rr},${rr} 0 0 1 ${rr},${-rr}h${w - rr * 2}a${rr},${rr} 0 0 1 ${rr},${rr}v${h - rr}h${-w}Z`
}

/** Donut segment. Angles in radians, clockwise from 12 o'clock. */
export function arcPath(cx: number, cy: number, rOuter: number, rInner: number, a0: number, a1: number): string {
  const sweep = a1 - a0
  const large = sweep > Math.PI ? 1 : 0
  const p = (r: number, a: number) => `${(cx + r * Math.sin(a)).toFixed(3)},${(cy - r * Math.cos(a)).toFixed(3)}`
  return [
    `M${p(rOuter, a0)}`,
    `A${rOuter},${rOuter} 0 ${large} 1 ${p(rOuter, a1)}`,
    `L${p(rInner, a1)}`,
    `A${rInner},${rInner} 0 ${large} 0 ${p(rInner, a0)}`,
    'Z',
  ].join('')
}
