import { Card, AxisExtent, LineChart, BarChart } from './components'
import { runningTotal } from './data/airia'

/**
 * The dashboard's measure card: a stack of categories by bucket, or their
 * running total, with a table twin and the isolation ghost.
 *
 * Both cards on the page are this. They were two ~85-line copies differing
 * only in their series and formatters, which is how the cumulative view
 * once kept showing all models after a click isolated one in the daily
 * view — fixed in one copy, missed in the other.
 *
 * Everything it draws comes off `series` and the totals derived from it, so
 * the legend, both charts and both tables cannot disagree about what is on
 * show. The old cards restated the category list four times each.
 *
 * It is not part of the kit: it knows about isolation and about this
 * dashboard's two views. It composes `Card`, `BarChart` and `LineChart`,
 * which are.
 */

export type ChartView = 'daily' | 'cumulative'

export interface ChartCardCategory {
  key: string
  label: string
  color: string
  values: number[]
}

export interface ChartCardProps {
  title: string
  /** The headline figure. Describes what is PLOTTED, so it follows an
   *  isolation rather than reporting the window's all-series total. */
  value: string
  view: ChartView
  onView: (v: ChartView) => void
  /** Bucket starts, ascending. */
  x: readonly number[]
  /** Stack categories, in stack order, bottom first. */
  series: readonly ChartCardCategory[]
  /** Per-bucket totals of the series ON SHOW — never an all-series summary,
   *  which is what made the cumulative line ignore isolation. */
  totals: number[]
  /** The same totals for the current scope. Drawn as the grey ghost behind
   *  an isolated series, and joining the y-domain so the two stay
   *  comparable. Null when nothing is isolated. */
  ghostTotals: number[] | null
  /** What the ghost is the whole OF, e.g. "all models". */
  ghostLabel?: string
  /** Tooltip and table cells for one bucket's value. */
  formatValue: (n: number) => string
  /** The same for a running total, where more precision is just noise:
   *  four decimal places earn their place on a single bucket of spend and
   *  clutter a three-month total. Defaults to `formatValue`. */
  formatTotal?: (n: number) => string
  /** Axis ticks. */
  formatTick: (n: number) => string
  /** Full label for a bucket, for tooltips and the table's time column. */
  formatX: (t: number) => string
  /** Which bucket indices the table samples, and how to stamp them. */
  tableRows: <T>(fmt: (i: number) => T) => T[]
  /** Under the plot: one line in BOTH views, so toggling cannot change the
   *  card's height and shove the page around. */
  note: string
  from: string
  to: string
  activeSeries?: string | null
  onSeriesHover?: (label: string | null) => void
  loading?: boolean
  className?: string
}

export function ChartCard({
  title, value, view, onView, x, series, totals, ghostTotals, ghostLabel,
  formatValue, formatTotal, formatTick, formatX, tableRows, note, from, to,
  activeSeries, onSeriesHover, loading, className,
}: ChartCardProps) {
  const daily = view === 'daily'
  const cumulative = runningTotal(totals)
  const fmt = daily ? formatValue : formatTotal ?? formatValue

  /* A running total must be reduced with `max`, never `sum`: if buckets are
     ever merged for display, summing would add closing balances together.
     It is monotonic, so the largest value in a merged bucket is its close. */
  const ghost = ghostTotals
    ? {
        label: ghostLabel ?? 'all',
        values: daily ? ghostTotals : runningTotal(ghostTotals),
        reducer: (daily ? 'sum' : 'max') as 'sum' | 'max',
      }
    : undefined

  return (
    <Card
      className={className}
      loading={loading}
      title={title}
      value={value}
      controls={<ViewToggle value={view} onChange={onView} />}
      /* Defined in both views — an empty array in the cumulative one — so
         the key row holds its height and the plot below it cannot shift. */
      legend={daily ? series.map((s) => ({ label: s.label, color: s.color, shape: 'rect' as const })) : []}
      activeSeries={activeSeries}
      onSeriesHover={onSeriesHover}
      footer={
        <>
          <AxisExtent from={from} to={to} />
          <p className="card-note" data-isolated={ghostTotals ? '' : undefined}>{note}</p>
        </>
      }
      table={daily
        ? {
            columns: [{ key: 't', label: 'Time' }, ...series.map((s) => ({ key: s.key, label: cap(s.label), align: 'right' as const }))],
            rows: tableRows((i) => ({
              t: formatX(x[i]),
              ...Object.fromEntries(series.map((s) => [s.key, formatValue(s.values[i])])),
            })),
          }
        : {
            columns: [
              { key: 't', label: 'Time' },
              { key: 'c', label: `Cumulative ${title.toLowerCase()}`, align: 'right' as const },
              ...(ghost ? [{ key: 'a', label: cap(ghost.label), align: 'right' as const }] : []),
            ],
            rows: tableRows((i) => ({
              t: formatX(x[i]),
              c: fmt(cumulative[i]),
              ...(ghost ? { a: fmt(ghost.values[i]) } : {}),
            })),
          }}
    >
      {daily ? (
        <BarChart
          x={x}
          reducer="sum"
          activeSeries={activeSeries}
          height={176}
          formatValue={formatValue}
          formatX={formatX}
          formatTick={formatTick}
          series={series}
          ghost={ghost}
        />
      ) : (
        <LineChart
          x={x}
          height={176}
          activeSeries={activeSeries}
          formatValue={fmt}
          formatX={formatX}
          formatTick={formatTick}
          series={[{ key: 'total', label: 'cumulative', color: series[0]?.color ?? '', values: cumulative, reducer: 'max', area: true }]}
          ghost={ghost}
        />
      )}
    </Card>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Daily / Cumulative switch, shown in the card's header row. */
function ViewToggle({ value, onChange }: { value: ChartView; onChange: (v: ChartView) => void }) {
  return (
    <div className="viz-viewtoggle" role="group" aria-label="Chart view">
      {(['daily', 'cumulative'] as const).map((v) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {v === 'daily' ? 'Daily' : 'Cumulative'}
        </button>
      ))}
    </div>
  )
}
