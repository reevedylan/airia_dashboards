import { useMemo, useState } from 'react'
import { useSize } from '../../lib/useSize'
import { arcPath } from '../../lib/path'
import { compact, percent } from '../../lib/format'
import { other as otherColor } from '../../theme/palette'

export interface DonutSlice {
  key: string
  label: string
  value: number
  color: string
}

export interface DonutChartProps {
  data: readonly DonutSlice[]
  /** Text under the centre figure, e.g. "Total errors". */
  centreLabel: string
  height?: number
  activeSeries?: string | null
  formatValue?: (n: number) => string
  /** Part-to-whole stops reading past ~6 arcs; the tail folds into "Other". */
  maxSlices?: number
  thickness?: number
}

const GAP_PX = 2
const LIFT_PX = 4

/**
 * Part-to-whole at a glance. Deliberately capped: this form is for "roughly
 * how does the whole split", not for comparing close values — the tooltip and
 * the table view carry the exact numbers.
 */
export function DonutChart({
  data, centreLabel, height = 210, activeSeries = null,
  formatValue = compact, maxSlices = 6, thickness = 26,
}: DonutChartProps) {
  const [ref, size] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<string | null>(null)
  const w = size.width

  const slices = useMemo(() => {
    const sorted = [...data].sort((a, b) => b.value - a.value)
    if (sorted.length <= maxSlices) return sorted
    const head = sorted.slice(0, maxSlices - 1)
    const tail = sorted.slice(maxSlices - 1)
    return [
      ...head,
      { key: '__other', label: `Other (${tail.length})`, color: otherColor, value: tail.reduce((a, s) => a + s.value, 0) },
    ]
  }, [data, maxSlices])

  const total = useMemo(() => slices.reduce((a, s) => a + s.value, 0), [slices])

  const model = useMemo(() => {
    if (w <= 0 || total <= 0) return null
    const cx = w / 2
    const cy = height / 2
    const rOuter = Math.max(24, Math.min(w, height) / 2 - LIFT_PX - 2)
    const rInner = Math.max(8, rOuter - thickness)
    const gapAngle = GAP_PX / rOuter

    let cursor = 0
    const arcs = slices.map((s) => {
      const sweep = (s.value / total) * Math.PI * 2
      const a0 = cursor
      const a1 = cursor + sweep
      cursor = a1
      // Only inset when the arc is wide enough to survive it.
      const inset = sweep > gapAngle * 2.5 ? gapAngle / 2 : 0
      return { ...s, share: s.value / total, a0: a0 + inset, a1: a1 - inset }
    })
    return { cx, cy, rOuter, rInner, arcs }
  }, [w, height, slices, total, thickness])

  const active = hover ?? activeSeries
  const focused = model?.arcs.find((a) => a.label === active || a.key === active) ?? null

  return (
    <div className="viz-plot viz-plot--centred" ref={ref} style={{ height }}>
      {model ? (
        <>
          <svg
            width={w}
            height={height}
            role="img"
            aria-label={`Donut chart: ${slices.map((s) => `${s.label} ${formatValue(s.value)}`).join(', ')}`}
          >
            <g onPointerLeave={() => setHover(null)}>
              {model.arcs.map((a) => {
                const isFocused = focused?.key === a.key
                const dim = active != null && !isFocused
                const r = isFocused ? model.rOuter + LIFT_PX : model.rOuter
                return (
                  <path
                    key={a.key}
                    d={arcPath(model.cx, model.cy, r, model.rInner, a.a0, a.a1)}
                    fill={a.color}
                    opacity={dim ? 0.3 : 1}
                    tabIndex={0}
                    role="img"
                    aria-label={`${a.label}: ${formatValue(a.value)}, ${percent(a.share)}`}
                    style={{ transition: 'opacity var(--viz-dur-base) var(--viz-ease)', cursor: 'default', outline: 'none' }}
                    onPointerEnter={() => setHover(a.key)}
                    onFocus={() => setHover(a.key)}
                    onBlur={() => setHover(null)}
                  />
                )
              })}
            </g>
          </svg>

          {/* The centre is the readout: total at rest, the hovered arc on
              hover. Width is pinned to the hole so a long series name wraps
              inside it instead of running under the ring. */}
          <div
            className="viz-donut__centre"
            aria-live="polite"
            style={{ width: model.rInner * 1.78 }}
          >
            <span className="viz-donut__value">{formatValue(focused ? focused.value : total)}</span>
            <span className="viz-donut__label">
              {focused ? `${focused.label} · ${percent(focused.share)}` : centreLabel}
            </span>
          </div>
        </>
      ) : null}
    </div>
  )
}
