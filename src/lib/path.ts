/** SVG path builders for line and area marks. */

export interface Pt { x: number; y: number }

/** Polyline through every point. Straight segments — no smoothing, so the
 *  path never invents a value between two samples. */
export function linePath(pts: readonly Pt[]): string {
  if (pts.length === 0) return ''
  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`
  for (let i = 1; i < pts.length; i++) d += `L${pts[i].x.toFixed(2)},${pts[i].y.toFixed(2)}`
  return d
}

/** The same polyline, closed down to a baseline, for the area wash. */
export function areaPath(pts: readonly Pt[], baseline: number): string {
  if (pts.length === 0) return ''
  const last = pts[pts.length - 1]
  return `${linePath(pts)}L${last.x.toFixed(2)},${baseline.toFixed(2)}L${pts[0].x.toFixed(2)},${baseline.toFixed(2)}Z`
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
