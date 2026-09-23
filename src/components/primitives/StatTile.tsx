import { Sparkline } from '../charts/Sparkline'

export interface StatTileProps {
  label: string
  value: string
  /**
   * Change against a named period.
   *
   * `tone` defaults to neutral, and usually should be: more spend, more
   * tokens or more executions is not inherently good or bad, and colouring
   * the arrow green or red asserts a judgement the number does not support.
   * Reserve good/bad for metrics that genuinely have a right direction.
   */
  delta?: {
    direction: 'up' | 'down' | 'none'
    text: string
    vs: string
    tone?: 'neutral' | 'good' | 'bad'
  }
  trend?: readonly number[]
  trendColor?: string
}

/** The figure contract: label · value · delta · trend. Used where a chart
 *  would be a one-bar bar chart. */
export function StatTile({ label, value, delta, trend, trendColor }: StatTileProps) {
  return (
    <div className="viz-stat">
      <span className="viz-stat__label">{label}</span>
      <span className="viz-stat__value">{value}</span>
      <span className="viz-stat__foot">
        {delta ? (
          <span className="viz-stat__delta" data-tone={delta.tone ?? 'neutral'}>
            <span aria-hidden="true">
              {delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '·'}
            </span>
            {delta.text}
            <span className="viz-stat__vs">{delta.vs}</span>
          </span>
        ) : null}
        {trend && trend.length > 1 ? <Sparkline values={trend} color={trendColor} width={72} height={20} /> : null}
      </span>
    </div>
  )
}
