import { useMemo, useState } from 'react'
import { useSize } from '../../lib/useSize'
import { linearScale, niceDomain, ticks, clamp, type Reducer } from '../../lib/scale'
import { linePath, areaPath, type Pt } from '../../lib/path'
import { compact, fullDate, grainFor } from '../../lib/format'
import { axisGutter } from '../../lib/axis'
import { Tooltip, type TooltipRow } from '../primitives/Tooltip'

export interface LineSeries {
  key: string
  label: string
  color: string
  values: readonly number[]
  /** Adds the 10% wash under the line. Sensible for one series, noisy for many. */
  area?: boolean
  /** How samples combine when the series is denser than the pixels available. */
  reducer?: Reducer
}

export interface LineChartProps {
  /** Timestamps in ms, ascending, aligned with every series' `values`. */
  x: readonly number[]
  series: readonly LineSeries[]
  height?: number
  /** Dim every series but this one (driven by legend hover). */
  activeSeries?: string | null
  formatValue?: (n: number) => string
  /** Force the y-axis to start at zero. On by default — a truncated axis
   *  exaggerates the wiggle in a volume series. */
  zeroBased?: boolean
  yTickCount?: number
  /** Formats the y-axis tick labels. Defaults to `formatValue`, but ticks
   *  usually want a shorter form: "$1.2K" on the axis, "$1,238.40" in the
   *  tooltip. */
  formatTick?: (n: number) => string
  /**
   * Label the gridlines. On by default: without it the only way to read a
   * magnitude is to hover, and the axis is what carries the values no direct
   * label does. Turn it off only where a hero figure already gives the scale.
   */
  yAxis?: boolean
  /**
   * Pixels per plotted vertex. Lines need more room than bars: below ~3px the
   * peaks overlap into a solid band and the shape stops being readable, however
   * many samples you feed in. Lower it for a denser, spikier read.
   */
  pxPerPoint?: number
}

const PAD = { top: 10, right: 6, bottom: 4, left: 6 }

export function LineChart({
  x, series, height = 170, activeSeries = null,
  formatValue = compact, zeroBased = true, yTickCount = 3, yAxis = true, formatTick, pxPerPoint = 4,
}: LineChartProps) {
  const [ref, size] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const w = size.width

  const model = useMemo(() => {
    if (w <= 0 || x.length === 0) return null

    // Provisional gutter so the density reduction has a width to work with;
    // replaced below once the tick labels are known.
    const provisionalLeft = PAD.left + (yAxis ? 40 : 0)
    const plotW0 = Math.max(1, w - provisionalLeft - PAD.right)
    const plotH = Math.max(1, height - PAD.top - PAD.bottom)

    // Bucket once, so every series stays aligned to the same x positions.
    const stride = Math.max(1, Math.ceil(x.length / Math.max(2, plotW0 / pxPerPoint)))
    const buckets: Array<[number, number]> = []
    for (let i = 0; i < x.length; i += stride) buckets.push([i, Math.min(i + stride, x.length)])

    const times = buckets.map(([s, e]) => x[Math.floor((s + e - 1) / 2)])
    const reduced = series.map((s) => ({
      ...s,
      points: buckets.map(([start, end]) => {
        let sum = 0, max = -Infinity
        for (let i = start; i < end; i++) { const v = s.values[i] ?? 0; sum += v; if (v > max) max = v }
        const n = end - start
        return s.reducer === 'sum' ? sum : s.reducer === 'max' ? max : sum / n
      }),
    }))

    let lo = Infinity, hi = -Infinity
    for (const s of reduced) for (const v of s.points) { if (v < lo) lo = v; if (v > hi) hi = v }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1 }
    const [y0, y1] = niceDomain(zeroBased ? Math.min(0, lo) : lo, hi, yTickCount)

    // Size the gutter to the labels it has to hold.
    const tickFmt = formatTick ?? formatValue
    const tickValues = ticks(y0, y1, yTickCount)
    const tickLabels = tickValues.map(tickFmt)
    const left = PAD.left + axisGutter(tickLabels, yAxis)
    const plotW = Math.max(1, w - left - PAD.right)

    const xs = linearScale([0, Math.max(1, times.length - 1)], [left, left + plotW])
    const ys = linearScale([y0, y1], [PAD.top + plotH, PAD.top])

    return {
      times, plotH, stride, left,
      gridlines: tickValues.map((v, i) => ({ v, y: ys(v), label: tickLabels[i] })),
      baseline: ys(y0),
      lines: reduced.map((s) => {
        const pts: Pt[] = s.points.map((v, i) => ({ x: xs(i), y: ys(v) }))
        return { ...s, pts, d: linePath(pts), fill: s.area ? areaPath(pts, ys(y0)) : null }
      }),
      xAt: (i: number) => xs(i),
    }
  }, [w, height, x, series, zeroBased, yTickCount, yAxis, pxPerPoint, formatTick, formatValue])

  const grain = useMemo(() => grainFor((x[x.length - 1] ?? 0) - (x[0] ?? 0)), [x])

  function pick(clientX: number, rect: DOMRect) {
    if (!model || model.times.length === 0) return
    const rel = clientX - rect.left
    const first = model.xAt(0)
    const last = model.xAt(model.times.length - 1)
    const t = (rel - first) / Math.max(1e-6, last - first)
    setHover(clamp(Math.round(t * (model.times.length - 1)), 0, model.times.length - 1))
  }

  const hoveredRows: TooltipRow[] = model && hover != null
    ? model.lines.map((s) => ({ color: s.color, label: s.label, value: formatValue(s.points[hover] ?? 0), swatch: 'line' as const }))
    : []

  return (
    <div className="viz-plot" ref={ref} style={{ height }}>
      {model ? (
        <>
          <svg
            width={w}
            height={height}
            role="img"
            aria-label={`Line chart: ${series.map((s) => s.label).join(', ')}`}
            tabIndex={0}
            onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
            onPointerLeave={() => setHover(null)}
            onBlur={() => setHover(null)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              e.preventDefault()
              const n = model.times.length
              setHover((h) => clamp((h ?? 0) + (e.key === 'ArrowRight' ? 1 : -1), 0, n - 1))
            }}
          >
            <g aria-hidden="true">
              {model.gridlines.map((g) => (
                <line key={g.v} x1={model.left} x2={w - PAD.right} y1={g.y} y2={g.y} className="viz-grid-line" />
              ))}
              {yAxis
                ? model.gridlines.map((g) => (
                    <text key={`t${g.v}`} x={model.left - 8} y={g.y} className="viz-tick" textAnchor="end" dominantBaseline="middle">
                      {g.label}
                    </text>
                  ))
                : null}
            </g>

            {model.lines.map((s) => {
              const dim = activeSeries != null && activeSeries !== s.label
              return (
                <g key={s.key} opacity={dim ? 0.22 : 1} style={{ transition: 'opacity var(--viz-dur-base) var(--viz-ease)' }}>
                  {s.fill ? <path d={s.fill} fill={s.color} fillOpacity="var(--viz-area-alpha)" /> : null}
                  <path
                    d={s.d}
                    fill="none"
                    stroke={s.color}
                    strokeWidth="var(--viz-stroke-line)"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </g>
              )
            })}

            {hover != null ? (
              <g aria-hidden="true">
                <line
                  x1={model.xAt(hover)} x2={model.xAt(hover)}
                  y1={PAD.top} y2={model.baseline}
                  className="viz-crosshair"
                />
                {model.lines.map((s) => (
                  <circle
                    key={s.key}
                    cx={model.xAt(hover)}
                    cy={s.pts[hover]?.y ?? 0}
                    r="4"
                    fill={s.color}
                    stroke="var(--viz-surface)"
                    strokeWidth="2"
                  />
                ))}
              </g>
            ) : null}
          </svg>

          {hover != null ? (
            <Tooltip
              x={model.xAt(hover)}
              y={Math.min(...model.lines.map((s) => s.pts[hover]?.y ?? 0))}
              width={w}
              height={height}
              title={fullDate(model.times[hover], grain)}
              rows={hoveredRows}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}
