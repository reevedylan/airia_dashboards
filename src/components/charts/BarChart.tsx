import { useMemo, useState } from 'react'
import { useSize } from '../../lib/useSize'
import { linearScale, niceDomain, ticks, bandScale, clamp, type Reducer } from '../../lib/scale'
import { barPath } from '../../lib/path'
import { compact, fullDate, grainFor } from '../../lib/format'
import { axisGutter } from '../../lib/axis'
import { Tooltip, type TooltipRow } from '../primitives/Tooltip'

export interface BarSeries {
  key: string
  label: string
  color: string
  /** `null` marks a bucket with no data. */
  values: readonly (number | null)[]
}

export interface BarChartProps {
  /** Timestamps in ms, ascending, aligned with every series' `values`. */
  x: readonly number[]
  /** One series draws plain columns; several stack, separated by a 2px gap. */
  series: readonly BarSeries[]
  height?: number
  activeSeries?: string | null
  formatValue?: (n: number) => string
  /** How samples combine when there are more bars than pixels. */
  reducer?: Reducer
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
  /** Label the gridlines — see the note on LineChart. */
  yAxis?: boolean
  /**
   * A faint reference series drawn BEHIND the stack, on the same scale — for
   * showing the unfiltered whole while the stack shows an isolated part.
   *
   * It joins the y-domain, so isolating a series does not rescale the axis and
   * the part keeps its true size relative to the whole.
   */
  ghost?: { label: string; values: readonly (number | null)[] }
}

const PAD = { top: 10, right: 6, bottom: 2, left: 6 }
/** A bar narrower than this is a sliver that aliases into a smear. */
const MIN_BAR_PX = 2
/** A stack segment shorter than this is dropped rather than drawn. */
const MIN_SEG_PX = 1

export function BarChart({
  x, series, height = 170, activeSeries = null,
  formatValue = compact, reducer = 'sum', yTickCount = 3, yAxis = true, formatTick, formatX, ghost,
}: BarChartProps) {
  const [ref, size] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const w = size.width

  const model = useMemo(() => {
    if (w <= 0 || x.length === 0 || series.length === 0) return null

    // Provisional gutter so the density reduction has a width to work with;
    // replaced below once the tick labels are known.
    const provisionalLeft = PAD.left + (yAxis ? 40 : 0)
    const plotW0 = Math.max(1, w - provisionalLeft - PAD.right)
    const plotH = Math.max(1, height - PAD.top - PAD.bottom)

    // Bucket down to the number of bars the card can actually paint. The
    // chart stays dense — hundreds of thin columns — but never sub-pixel.
    const maxBars = Math.max(2, Math.floor(plotW0 / MIN_BAR_PX))
    const stride = Math.max(1, Math.ceil(x.length / maxBars))
    const buckets: Array<[number, number]> = []
    for (let i = 0; i < x.length; i += stride) buckets.push([i, Math.min(i + stride, x.length)])

    const times = buckets.map(([s, e]) => x[Math.floor((s + e - 1) / 2)])
    const reduced = series.map((s) => ({
      ...s,
      points: buckets.map(([start, end]) => {
        let sum = 0, max = -Infinity, n = 0
        for (let i = start; i < end; i++) {
          const v = s.values[i]
          if (v == null || !Number.isFinite(v)) continue
          sum += v
          if (v > max) max = v
          n += 1
        }
        if (n === 0) return null
        return reducer === 'mean' ? sum / n : reducer === 'max' ? max : sum
      }) as (number | null)[],
    }))

    const totals = times.map((_, i) => reduced.reduce((acc, s) => acc + Math.max(0, s.points[i] ?? 0), 0))

    // Bucket the ghost the same way, so it lines up with the stack.
    const ghostPoints = ghost
      ? buckets.map(([start, end]) => {
          let acc = 0
          for (let i = start; i < end; i++) acc += Math.max(0, ghost.values[i] ?? 0)
          return reducer === 'mean' ? acc / Math.max(1, end - start) : acc
        })
      : null

    const [y0, y1] = niceDomain(0, Math.max(...totals, ...(ghostPoints ?? []), 1), yTickCount)

    // Size the gutter to the labels it has to hold.
    const tickFmt = formatTick ?? formatValue
    const tickValues = ticks(y0, y1, yTickCount)
    const tickLabels = tickValues.map(tickFmt)
    const left = PAD.left + axisGutter(tickLabels, yAxis)
    const plotW = Math.max(1, w - left - PAD.right)

    const band = bandScale(times.length, plotW, 2, 24)
    const ys = linearScale([y0, y1], [PAD.top + plotH, PAD.top])
    const baseline = ys(y0)
    const gap = band.width > 4 ? 2 : 0
    const radius = Math.min(4, band.width / 2)

    /**
     * Stack from the baseline up.
     *
     * A segment shorter than MIN_SEG_PX is not drawn at all. Forcing a
     * minimum height on a negligible category turned it into a detached tick
     * floating above the bar — its own surface gap pushed it clear of the
     * stack, so a rounding-error value read as a mark of its own. Its value is
     * still in the tooltip, which is where that detail belongs.
     *
     * The gap is likewise only carved out of segments comfortably larger than
     * it; otherwise a small-but-real segment would detach the same way.
     */
    const columns = times.map((_, i) => {
      let cursor = baseline
      let drawn = 0
      const segs = reduced.map((s) => {
        const v = Math.max(0, s.points[i] ?? 0)
        const raw = baseline - ys(v)
        const base = { key: s.key, label: s.label, color: s.color, value: v }
        if (raw < MIN_SEG_PX) return { ...base, top: cursor, h: 0 }
        const lead = drawn > 0 && reduced.length > 1 && raw > gap * 2 ? gap : 0
        const top = cursor - raw
        cursor = top
        drawn += 1
        return { ...base, top, h: raw - lead }
      })
      return { x: band.at(i), segs, ghost: ghostPoints ? baseline - ys(ghostPoints[i]) : 0 }
    })

    return {
      times, columns, band, baseline, stride, radius, left, ghostPoints,
      gridlines: tickValues.map((v, i) => ({ v, y: ys(v), label: tickLabels[i] })),
      seriesMeta: reduced,
    }
  }, [w, height, x, series, reducer, yTickCount, yAxis, formatTick, formatValue, ghost])

  const grain = useMemo(() => grainFor((x[x.length - 1] ?? 0) - (x[0] ?? 0)), [x])

  function pick(clientX: number, rect: DOMRect) {
    if (!model) return
    const rel = clientX - rect.left - model.left
    setHover(clamp(Math.floor(rel / model.band.step), 0, model.times.length - 1))
  }

  const rows: TooltipRow[] = model && hover != null
    ? [
        ...model.seriesMeta.map((s) => {
          const v = s.points[hover]
          return { color: s.color, label: s.label, value: v == null ? '—' : formatValue(v), swatch: 'rect' as const }
        }),
        {
          color: 'transparent',
          label: 'Total',
          value: formatValue(model.seriesMeta.reduce((acc, s) => acc + Math.max(0, s.points[hover] ?? 0), 0)),
          emphasis: true,
        },
        ...(ghost && model.ghostPoints
          ? [{
              color: 'var(--viz-other)',
              label: ghost.label,
              value: formatValue(model.ghostPoints[hover] ?? 0),
              swatch: 'rect' as const,
              emphasis: true,
            }]
          : []),
      ]
    : []

  const bucketNote = model && model.stride > 1
    ? `${model.stride} samples per bar`
    : undefined

  return (
    <div className="viz-plot" ref={ref} style={{ height }}>
      {model ? (
        <>
          <svg
            width={w}
            height={height}
            role="img"
            aria-label={`Bar chart: ${series.map((s) => s.label).join(', ')}`}
            tabIndex={0}
            onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
            onPointerLeave={() => setHover(null)}
            onBlur={() => setHover(null)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              e.preventDefault()
              setHover((h) => clamp((h ?? 0) + (e.key === 'ArrowRight' ? 1 : -1), 0, model.times.length - 1))
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

            {/* A hovered column gets a wash the full height of the plot, so a
                1px bar is still findable without aiming at it. */}
            {hover != null ? (
              <rect
                aria-hidden="true"
                x={model.left + hover * model.band.step}
                y={PAD.top}
                width={model.band.step}
                height={model.baseline - PAD.top}
                className="viz-band-hover"
              />
            ) : null}

            {ghost ? (
              <g aria-hidden="true">
                {model.columns.map((col, i) =>
                  col.ghost <= 0.5 ? null : (
                    <path
                      key={`g${i}`}
                      d={barPath(model.left + col.x, model.baseline - col.ghost, model.band.width, col.ghost, model.radius)}
                      className="viz-ghost-bar"
                    />
                  ),
                )}
              </g>
            ) : null}

            <g>
              {model.columns.map((col, i) => (
                <g key={i}>
                  {col.segs.map((seg) =>
                    seg.h <= 0 ? null : (
                      <path
                        key={seg.key}
                        d={barPath(model.left + col.x, seg.top, model.band.width, seg.h, model.radius)}
                        fill={seg.color}
                        opacity={activeSeries != null && activeSeries !== seg.label ? 0.22 : 1}
                      />
                    ),
                  )}
                </g>
              ))}
            </g>

            <line
              aria-hidden="true"
              x1={model.left} x2={w - PAD.right}
              y1={model.baseline} y2={model.baseline}
              className="viz-axis-line"
            />
          </svg>

          {hover != null ? (
            <Tooltip
              x={model.left + hover * model.band.step + model.band.step / 2}
              y={Math.min(...model.columns[hover].segs.map((s) => s.top))}
              width={w}
              height={height}
              title={formatX ? formatX(model.times[hover]) : fullDate(model.times[hover], grain)}
              rows={rows}
              footer={bucketNote}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}
