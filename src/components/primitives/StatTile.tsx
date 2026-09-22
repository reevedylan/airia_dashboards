import { Sparkline } from '../charts/Sparkline'

export interface StatTileProps {
  label: string
  value: string
  /** Signed, against a named period — e.g. { text: '+12.4%', good: true, vs: 'vs last month' } */
  delta?: { text: string; good: boolean; vs: string }
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
          <span className="viz-stat__delta" data-good={delta.good ? '' : undefined}>
            <span aria-hidden="true">{delta.good ? '▲' : '▼'}</span>
            {delta.text}
            <span className="viz-stat__vs">{delta.vs}</span>
          </span>
        ) : null}
        {trend && trend.length > 1 ? <Sparkline values={trend} color={trendColor} width={72} height={20} /> : null}
      </span>
    </div>
  )
}
