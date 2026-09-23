import { useId, useMemo, useState } from 'react'
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
  /** `null` marks a bucket with no data — drawn as a break, not a zero. */
  values: readonly (number | null)[]
  /** Adds the 10% wash under the line. Sensible for one series, noisy for many. */
  area?: boolean
  /**
   * Dash the stroke. Reserved for a series that is not measured — a
   * projection or a reference pace. Gridlines and axes stay solid; dashing
   * them reads as "threshold" when it is just a grid.
   */
  dashed?: boolean
  /** How samples combine when the series is denser than the pixels available. */
  reducer?: Reducer
  /**
   * Per-sample weights for the `mean` reducer, aligned with `values`.
   *
   * Required for any RATE or RATIO series. Averaging pre-computed ratios is a
   * mean-of-means and does not equal the true rate: a five-minute bucket with
   * one request would otherwise count as much as one with ten thousand. Pass
   * the ratio's denominator here and the reducer computes
   * sum(value x weight) / sum(weight), which is the real rate at any zoom.
   */
  weights?: readonly number[]
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
   * Labels the x position in the tooltip. Supply this whenever the bucket
   * size is known: the chart's own fallback infers a format from the total
   * span, which drops the time of day on any range wider than a few days.
   */
  formatX?: (t: number) => string
  /**
   * A faint reference series drawn BEHIND the lines, on the same scale — for
   * showing the unfiltered whole while the lines show an isolated part.
   *
   * It joins the y-domain, so isolating does not rescale the axis and the part
   * keeps its true size relative to the whole. Not a series: it takes the
   * de-emphasis grey, carries no legend entry, and is never coloured.
   */
  ghost?: { label: string; values: readonly (number | null)[]; reducer?: Reducer }
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
  formatValue = compact, zeroBased = true, yTickCount = 3, yAxis = true, formatTick, formatX, ghost, pxPerPoint = 4,
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
      // Nulls are skipped rather than counted as zero: a mean over a window
      // that is half missing must average what exists, and a window that is
      // entirely missing stays missing.
      points: buckets.map(([start, end]) => {
        let sum = 0, max = -Infinity, n = 0
        let wSum = 0, wTotal = 0
        for (let i = start; i < end; i++) {
          const v = s.values[i]
          if (v == null || !Number.isFinite(v)) continue
          sum += v
          if (v > max) max = v
          n += 1
          if (s.weights) {
            const w = s.weights[i] ?? 0
            wSum += v * w
            wTotal += w
          }
        }
        if (n === 0) return null
        if (s.reducer === 'sum') return sum
        if (s.reducer === 'max') return max
        if (s.weights) return wTotal === 0 ? null : wSum / wTotal
        return sum / n
      }) as (number | null)[],
    }))

    const ghostPoints = ghost
      ? buckets.map(([start, end]) => {
          let sum = 0, max = -Infinity, n = 0
          for (let i = start; i < end; i++) {
            const v = ghost.values[i]
            if (v == null || !Number.isFinite(v)) continue
            sum += v; if (v > max) max = v; n += 1
          }
          if (n === 0) return null
          const r = ghost.reducer ?? 'sum'
          return r === 'max' ? max : r === 'mean' ? sum / n : sum
        })
      : null

    let lo = Infinity, hi = -Infinity
    for (const s of reduced) for (const v of s.points) {
      if (v == null) continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    for (const v of ghostPoints ?? []) {
      if (v == null) continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
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

    const ghostPts: (Pt | null)[] = (ghostPoints ?? []).map((v, i) => (v == null ? null : { x: xs(i), y: ys(v) }))

    return {
      times, plotH, stride, left,
      ghostPoints,
      ghostLine: ghostPoints ? linePath(ghostPts) : null,
      ghostArea: ghostPoints ? areaPath(ghostPts, ys(y0)) : null,
      ghostTop: Math.min(PAD.top + plotH, ...ghostPts.filter((p): p is Pt => p != null).map((p) => p.y)),
      gridlines: tickValues.map((v, i) => ({ v, y: ys(v), label: tickLabels[i] })),
      baseline: ys(y0),
      lines: reduced.map((s) => {
        const pts: (Pt | null)[] = s.points.map((v, i) => (v == null ? null : { x: xs(i), y: ys(v) }))
        /* An area fades from its OWN highest point, not from the top of the
           plot. Anchoring it to the plot put the strong end of the ramp in
           empty space above the data: a line peaking at three quarters of
           the axis got only the faint three quarters of the fade. */
        const top = Math.min(...pts.filter((p): p is Pt => p != null).map((p) => p.y))
        return {
          ...s, pts, d: linePath(pts),
          top: Number.isFinite(top) ? top : PAD.top,
          fill: s.area ? areaPath(pts, ys(y0)) : null,
        }
      }),
      xAt: (i: number) => xs(i),
    }
  }, [w, height, x, series, zeroBased, yTickCount, yAxis, pxPerPoint, formatTick, formatValue, ghost])

  /** Gradient ids have to be unique per chart INSTANCE: two cumulative cards
   *  share series keys, and a duplicate id silently wins for both. */
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, '')

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
    ? [
        ...model.lines.map((s) => {
          const v = s.points[hover]
          return { color: s.color, label: s.label, value: v == null ? '—' : formatValue(v), swatch: 'line' as const }
        }),
        ...(ghost && model.ghostPoints
          ? [{
              color: 'var(--viz-other)',
              label: ghost.label,
              value: model.ghostPoints[hover] == null ? '—' : formatValue(model.ghostPoints[hover]!),
              swatch: 'line' as const,
              emphasis: true,
            }]
          : []),
      ]
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

            {/*
              One vertical gradient per filled area, spanning the PLOT rather
              than each path's own box: the fade then means the same thing in
              every series and on every chart, instead of stretching to fit
              whatever height a particular curve happened to reach.

              The stops carry no colour of their own — they read
              `currentColor`, set on the gradient from the series colour — so
              the hexes stay in the theme and the opacities stay in tokens.
            */}
            <defs>
              {model.ghostArea ? (
                <linearGradient id={`${gid}-ghost`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={model.ghostTop} y2={model.baseline}>
                  <stop offset="0%" className="viz-area-stop--ghost-top" />
                  <stop offset="100%" className="viz-area-stop--ghost-bottom" />
                </linearGradient>
              ) : null}
              {model.lines.filter((s) => s.fill).map((s) => (
                <linearGradient
                  key={s.key}
                  id={`${gid}-${s.key}`}
                  gradientUnits="userSpaceOnUse"
                  x1="0" x2="0" y1={s.top} y2={model.baseline}
                  style={{ color: s.color }}
                >
                  <stop offset="0%" className="viz-area-stop--top" />
                  <stop offset="100%" className="viz-area-stop--bottom" />
                </linearGradient>
              ))}
            </defs>

            {model.ghostArea ? (
              <g aria-hidden="true">
                <path d={model.ghostArea} fill={`url(#${gid}-ghost)`} />
                <path d={model.ghostLine ?? ''} className="viz-ghost-line" fill="none" />
              </g>
            ) : null}

            {model.lines.map((s) => {
              const dim = activeSeries != null && activeSeries !== s.label
              return (
                <g key={s.key} opacity={dim ? 0.22 : 1} style={{ transition: 'opacity var(--viz-dur-base) var(--viz-ease)' }}>
                  {s.fill ? <path d={s.fill} fill={`url(#${gid}-${s.key})`} /> : null}
                  <path
                    d={s.d}
                    fill="none"
                    stroke={s.color}
                    strokeWidth="var(--viz-stroke-line)"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    strokeDasharray={s.dashed ? '5 4' : undefined}
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
                {model.lines.map((s) => {
                  const p = s.pts[hover]
                  if (!p) return null
                  return (
                    <circle
                      key={s.key}
                      cx={model.xAt(hover)}
                      cy={p.y}
                      r="4"
                      fill={s.color}
                      stroke="var(--viz-surface)"
                      strokeWidth="2"
                    />
                  )
                })}
              </g>
            ) : null}
          </svg>

          {hover != null ? (
            <Tooltip
              x={model.xAt(hover)}
              y={Math.min(
                ...model.lines.map((s) => s.pts[hover]?.y).filter((y): y is number => y != null),
                height,
              )}
              width={w}
              height={height}
              title={formatX ? formatX(model.times[hover]) : fullDate(model.times[hover], grain)}
              rows={hoveredRows}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}
