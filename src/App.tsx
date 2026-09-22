import { useMemo, useState } from 'react'
import {
  Card, AxisExtent, LineChart, BarChart, RankTable, StatTile,
  TimeRangeBar, ToolbarButton, FilterIcon, SavedIcon,
  type RangeKey,
} from './components'
import { series, other as otherColor } from './theme/palette'
import { axisDate, compact, currency, full, grainFor, stamp } from './lib/format'
import { useAiria, sliceRange, runningTotal, pacedProjection } from './data/airia'
import { PaletteSheet } from './demo/PaletteSheet'
import { useTheme } from './lib/theme'

/**
 * Colours are assigned to measures by identity, once — never by rank or array
 * position — so changing the range or filtering a series never repaints the
 * survivors.
 *
 * The stack orders below were validated with `scripts/validate-palette.mjs`:
 * the default palette seats yellow next to orange, which is the one adjacent
 * pair that fails the colourblind gate, so these orders skip slot 4.
 */
type ChartView = 'daily' | 'cumulative'

const C = {
  cached: series(1),   // blue   — dominates both charts, sits at the base
  input: series(3),    // aqua
  output: series(2),   // orange
  write: series(7),    // violet
  other: series(5),    // magenta
  total: series(1),
  // The pace line is derived, not measured, so it recedes to the
  // de-emphasis grey rather than taking a categorical slot.
  pace: otherColor,
} as const

export default function App() {
  const [range, setRange] = useState<RangeKey>('3M')
  const [active, setActive] = useState<string | null>(null)
  const [tokenView, setTokenView] = useState<ChartView>('daily')
  const [spendView, setSpendView] = useState<ChartView>('daily')
  const [theme, setTheme] = useTheme()
  const load = useAiria()

  const slice = useMemo(
    () => (load.status === 'ready' ? sliceRange(load.data, range) : null),
    [load, range],
  )

  const grain = useMemo(
    () => (slice && slice.x.length > 1 ? grainFor(slice.x[slice.x.length - 1] - slice.x[0]) : 'day'),
    [slice],
  )

  const toolbar = (
    <TimeRangeBar
      value={range}
      onChange={setRange}
      actions={
        <>
          <ToolbarButton icon={<FilterIcon />}>Show Filters</ToolbarButton>
          <ToolbarButton icon={<SavedIcon />}>Saved Filters</ToolbarButton>
          <ToolbarButton icon={<ThemeIcon />} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? 'Light' : 'Dark'}
          </ToolbarButton>
        </>
      }
    />
  )

  if (load.status !== 'ready' || !slice) {
    return (
      <div className="page">
        <Head />
        {toolbar}
        <EmptyState state={load} />
      </div>
    )
  }

  // balanceUsed is deliberately not shown: it does not apply to gateway
  // traffic, which bills against the caller's own provider credentials.
  const { x, tokens, cost, executions, models, paid, totals } = slice
  const from = axisDate(x[0], grain)
  const to = axisDate(x[x.length - 1], grain)
  const rowStamp = (i: number) => stamp(x[i], load.data.meta.bucketMs < 86_400_000)

  /* Table twins are sampled to a readable length. Sampling every Nth bucket
     would be near-useless here: only ~9% of five-minute buckets contain any
     execution, so a flat stride lands almost entirely on empty ones and the
     table reads as a column of zeros. Sample the ACTIVE buckets instead, so
     the twin actually carries the values the chart is showing. */
  /* Cumulative views accumulate from zero at the start of the SELECTED window,
     so they reset on every range change rather than running all-time. */
  const tokenTotals = x.map((_, i) => tokens.input[i] + tokens.cached[i] + tokens.output[i])
  const tokenCumulative = runningTotal(tokenTotals)
  const tokenPace = pacedProjection(tokenTotals)
  const spendCumulative = runningTotal(paid)
  const spendPace = pacedProjection(paid)

  const activeBuckets = x.map((_, i) => i).filter((i) => executions[i] > 0)
  const tableStride = Math.max(1, Math.floor(activeBuckets.length / 120))
  const rows = <T,>(fmt: (i: number) => T) =>
    activeBuckets.filter((_, n) => n % tableStride === 0).map(fmt)


  return (
    <div className="page">
      <Head />
      {toolbar}

      <div className="strip">
        <StatTile label="Token spend" value={currency(totals.cost)} />
        <StatTile label="Tokens" value={compact(totals.tokens)} />
        <StatTile label="Executions" value={full(totals.executions)} />
      </div>

      <div className="grid">
        <Card
          className="grid__wide"
          title="Tokens"
          value={compact(totals.tokens)}
          controls={<ViewToggle value={tokenView} onChange={setTokenView} />}
          legend={tokenView === 'daily'
            ? [
                { label: 'cached input', color: C.cached, shape: 'rect' },
                { label: 'input', color: C.input, shape: 'rect' },
                { label: 'output', color: C.output, shape: 'rect' },
              ]
            : [
                { label: 'cumulative', color: C.total, shape: 'line' },
                { label: `at current pace — ${compact(tokenPace[tokenPace.length - 1] ?? 0)}`, color: C.pace, shape: 'line' },
              ]}
          activeSeries={active}
          onSeriesHover={setActive}
          footer={
            <>
              <AxisExtent from={from} to={to} />
              {tokenView === 'cumulative' ? (
                <p className="card-note">
                  Running total from zero at the start of the selected window. The dashed
                  line is the window's average rate. Both finish at the same total, so
                  where the solid line runs <em>below</em> the dashes the total accrued
                  late — recent usage is outpacing the window average.
                </p>
              ) : null}
            </>
          }
          table={tokenView === 'daily'
            ? {
                columns: [
                  { key: 't', label: 'Time' },
                  { key: 'c', label: 'Cached input', align: 'right' },
                  { key: 'i', label: 'Input', align: 'right' },
                  { key: 'o', label: 'Output', align: 'right' },
                ],
                rows: rows((i) => ({
                  t: rowStamp(i), c: full(tokens.cached[i]), i: full(tokens.input[i]), o: full(tokens.output[i]),
                })),
              }
            : {
                columns: [
                  { key: 't', label: 'Time' },
                  { key: 'c', label: 'Cumulative tokens', align: 'right' },
                  { key: 'p', label: 'At current pace', align: 'right' },
                ],
                rows: rows((i) => ({
                  t: rowStamp(i), c: full(tokenCumulative[i]), p: full(Math.round(tokenPace[i])),
                })),
              }}
        >
          {tokenView === 'daily' ? (
            <BarChart
              x={x}
              reducer="sum"
              activeSeries={active}
              height={176}
              formatValue={(n) => full(n)}
              formatTick={compact}
              series={[
                { key: 'cached', label: 'cached input', color: C.cached, values: tokens.cached },
                { key: 'input', label: 'input', color: C.input, values: tokens.input },
                { key: 'output', label: 'output', color: C.output, values: tokens.output },
              ]}
            />
          ) : (
            <LineChart
              x={x}
              height={176}
              activeSeries={active}
              formatValue={(n) => full(Math.round(n))}
              formatTick={compact}
              series={[
                // 'max' not 'sum': a running total must not be re-summed when
                // buckets are merged for display. It is monotonic, so the
                // largest value in a bucket is its closing value.
                { key: 'pace', label: 'at current pace', color: C.pace, values: tokenPace, reducer: 'max', dashed: true },
                { key: 'total', label: 'cumulative', color: C.total, values: tokenCumulative, reducer: 'max', area: true },
              ]}
            />
          )}
        </Card>

        <Card
          className="grid__wide"
          title="Token spend"
          value={currency(totals.cost)}
          controls={<ViewToggle value={spendView} onChange={setSpendView} />}
          legend={spendView === 'daily'
            ? [
                { label: 'write cache', color: C.write, shape: 'rect' },
                { label: 'cached input', color: C.cached, shape: 'rect' },
                { label: 'output', color: C.output, shape: 'rect' },
                { label: 'input', color: C.input, shape: 'rect' },
                { label: 'other', color: C.other, shape: 'rect' },
              ]
            : [
                { label: 'cumulative', color: C.total, shape: 'line' },
                { label: `at current pace — ${currency(spendPace[spendPace.length - 1] ?? 0)}`, color: C.pace, shape: 'line' },
              ]}
          activeSeries={active}
          onSeriesHover={setActive}
          footer={
            <>
              <AxisExtent from={from} to={to} />
              {spendView === 'cumulative' ? (
                <p className="card-note">
                  Running total from zero at the start of the selected window. The dashed
                  line is the window's average rate. Both finish at the same total, so
                  where the solid line runs <em>below</em> the dashes the spend accrued
                  late — the recent pace is above the window average.
                </p>
              ) : null}
            </>
          }
          table={spendView === 'daily'
            ? {
                columns: [
                  { key: 't', label: 'Time' },
                  { key: 'w', label: 'Write cache', align: 'right' },
                  { key: 'c', label: 'Cached', align: 'right' },
                  { key: 'o', label: 'Output', align: 'right' },
                  { key: 'i', label: 'Input', align: 'right' },
                  { key: 'x', label: 'Other', align: 'right' },
                ],
                rows: rows((i) => ({
                  t: rowStamp(i),
                  w: currency(cost.write[i], 4), c: currency(cost.cached[i], 4),
                  o: currency(cost.output[i], 4), i: currency(cost.input[i], 4),
                  x: currency(cost.other[i], 4),
                })),
              }
            : {
                columns: [
                  { key: 't', label: 'Time' },
                  { key: 'c', label: 'Cumulative spend', align: 'right' },
                  { key: 'p', label: 'At current pace', align: 'right' },
                ],
                rows: rows((i) => ({
                  t: rowStamp(i), c: currency(spendCumulative[i]), p: currency(spendPace[i]),
                })),
              }}
        >
          {spendView === 'daily' ? (
            <BarChart
              x={x}
              reducer="sum"
              activeSeries={active}
              height={176}
              formatValue={(n) => currency(n, 4)}
              formatTick={(n) => `$${compact(n)}`}
              series={[
                { key: 'write', label: 'write cache', color: C.write, values: cost.write },
                { key: 'cached', label: 'cached input', color: C.cached, values: cost.cached },
                { key: 'output', label: 'output', color: C.output, values: cost.output },
                { key: 'input', label: 'input', color: C.input, values: cost.input },
                { key: 'other', label: 'other', color: C.other, values: cost.other },
              ]}
            />
          ) : (
            <LineChart
              x={x}
              height={176}
              activeSeries={active}
              formatValue={(n) => currency(n)}
              formatTick={(n) => `$${compact(n)}`}
              series={[
                { key: 'pace', label: 'at current pace', color: C.pace, values: spendPace, reducer: 'max', dashed: true },
                { key: 'total', label: 'cumulative', color: C.total, values: spendCumulative, reducer: 'max', area: true },
              ]}
            />
          )}
        </Card>


        <Card
          className="grid__full"
          title="Models"
          table={{
            columns: [
              { key: 'm', label: 'Model' },
              { key: 'c', label: 'Spend', align: 'right' },
              { key: 'ti', label: 'Tokens in', align: 'right' },
              { key: 'to', label: 'Tokens out', align: 'right' },
              { key: 'i', label: 'Input $/M', align: 'right' },
              { key: 'o', label: 'Output $/M', align: 'right' },
              { key: 'n', label: 'Executions', align: 'right' },
            ],
            rows: models.map((m) => ({
              m: m.model,
              c: currency(m.spend),
              ti: full(m.tokensIn),
              to: full(m.tokensOut),
              i: m.inputRate == null ? '—' : currency(m.inputRate, 2),
              o: m.outputRate == null ? '—' : currency(m.outputRate, 2),
              n: full(m.executions),
            })),
          }}
        >
          <RankTable
            rows={models.map((m) => ({
              key: m.model,
              label: m.model,
              value: m.spend,
              cells: {
                tokensIn: m.tokensIn,
                tokensOut: m.tokensOut,
                inputRate: m.inputRate,
                outputRate: m.outputRate,
              },
            }))}
            labelHeading="Model"
            valueHeading="Spend"
            columns={[
              { key: 'tokensIn', heading: 'Tokens in', format: compact },
              { key: 'tokensOut', heading: 'Tokens out', format: compact },
              { key: 'inputRate', heading: 'in $/M', format: (n) => `$${n.toFixed(2)}` },
              { key: 'outputRate', heading: 'out $/M', format: (n) => `$${n.toFixed(2)}` },
            ]}
            limit={6}
            formatValue={(n) => currency(n)}
          />
        </Card>
      </div>

      <p className="page__note">
        {load.data.meta.source} executions only · {full(load.data.meta.rowCount)} rows
        ingested, {full(load.data.meta.amountsReconciled)} of which reconcile exactly
        {load.data.meta.amountsMismatched > 0
          ? ` (${load.data.meta.amountsMismatched} do not)`
          : ''} · {compact(load.data.meta.bucketCount)} buckets of {load.data.meta.bucketMs / 60_000} min ·
        generated {new Date(load.data.meta.generatedAt).toLocaleString('en-GB')}
      </p>

      <PaletteSheet />
    </div>
  )
}

/** Daily / Cumulative switch, shown in a chart card's header. */
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

function Head() {
  return (
    <header className="page__head">
      <h1>Gateway usage</h1>
    </header>
  )
}

function EmptyState({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'loading') return <div className="empty">Loading usage data…</div>
  if (state.status === 'missing') {
    return (
      <div className="empty">
        <strong>No ingested data yet.</strong>
        <p>The aggregates are gitignored, so a fresh clone starts empty. Generate them with:</p>
        <pre>AIRIA_API_KEY=akey_… node scripts/ingest-airia.mjs --days 90</pre>
      </div>
    )
  }
  return (
    <div className="empty">
      <strong>Could not load usage data.</strong>
      <p>{state.message}</p>
    </div>
  )
}

const ThemeIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="8" r="3.1" />
    <path d="M8 1.4v1.4M8 13.2v1.4M14.6 8h-1.4M2.8 8H1.4M12.7 3.3l-1 1M4.3 11.7l-1 1M12.7 12.7l-1-1M4.3 4.3l-1-1" />
  </svg>
)
