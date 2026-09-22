import { useMemo } from 'react'
import { linearScale } from '../../lib/scale'
import { areaPath, linePath, type Pt } from '../../lib/path'

export interface SparklineProps {
  values: readonly number[]
  color?: string
  width?: number
  height?: number
  area?: boolean
}

/** A trend shape with no axes — for stat tiles and table cells. */
export function Sparkline({ values, color = 'var(--viz-series-1)', width = 88, height = 24, area = true }: SparklineProps) {
  const { d, fill } = useMemo(() => {
    if (values.length < 2) return { d: '', fill: '' }
    const lo = Math.min(...values)
    const hi = Math.max(...values)
    const xs = linearScale([0, values.length - 1], [1, width - 1])
    const ys = linearScale([lo === hi ? lo - 1 : lo, hi], [height - 2, 2])
    const pts: Pt[] = values.map((v, i) => ({ x: xs(i), y: ys(v) }))
    return { d: linePath(pts), fill: areaPath(pts, height) }
  }, [values, width, height])

  return (
    <svg width={width} height={height} aria-hidden="true" className="viz-sparkline">
      {area ? <path d={fill} fill={color} fillOpacity="var(--viz-area-alpha)" /> : null}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
