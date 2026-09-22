import { useMemo, useState } from 'react'
import {
  Card, AxisExtent, LineChart, BarChart, RankTable, StatTile,
  TimeRangeBar, ToolbarButton, FilterIcon, SavedIcon,
  type RangeKey,
} from './components'
import { series, other as otherColor } from './theme/palette'
import { axisDate, compact, currency, full, grainFor, percent, stamp } from './lib/format'
import { useAiria, sliceRange } from './data/airia'
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
const C = {
  cached: series(1),   // blue   — dominates both charts, sits at the base
  input: series(3),    // aqua
  output: series(2),   // orange
  write: series(7),    // violet
  other: series(5),    // magenta
  paid: series(1),
  // The no-cache line is a hypothetical reference, not a measured series, so
  // it takes the de-emphasis grey rather than a categorical slot.
  counterfactual: otherColor,
} as const

export default function App() {
  const [range, setRange] = useState<RangeKey>('3M')
  const [active, setActive] = useState<string | null>(null)
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
  const { x, tokens, cost, executions, models, paid, withoutCache, totals } = slice
  const from = axisDate(x[0], grain)
  const to = axisDate(x[x.length - 1], grain)
  const rowStamp = (i: number) => stamp(x[i], load.data.meta.bucketMs < 86_400_000)

  /* Table twins are sampled to a readable length. Sampling every Nth bucket
     would be near-useless here: only ~9% of five-minute buckets contain any
     execution, so a flat stride lands almost entirely on empty ones and the
     table reads as a column of zeros. Sample the ACTIVE buckets instead, so
     the twin actually carries the values the chart is showing. */
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
        <StatTile
          label="Saved by caching"
          value={currency(totals.saved)}
          delta={totals.withoutCache === 0 ? undefined : {
            text: `${percent(totals.saved / totals.withoutCache, 0)} off`,
            good: true,
            vs: 'vs no caching',
          }}
        />
        <StatTile label="Executions" value={full(totals.executions)} />
      </div>

      <div className="grid">
        <Card
          className="grid__wide"
          title="Tokens"
          value={compact(totals.tokens)}
          legend={[
            { label: 'cached input', color: C.cached, shape: 'rect' },
            { label: 'input', color: C.input, shape: 'rect' },
            { label: 'output', color: C.output, shape: 'rect' },
          ]}
          activeSeries={active}
          onSeriesHover={setActive}
          footer={<AxisExtent from={from} to={to} />}
          table={{
            columns: [
              { key: 't', label: 'Time' },
              { key: 'c', label: 'Cached input', align: 'right' },
              { key: 'i', label: 'Input', align: 'right' },
              { key: 'o', label: 'Output', align: 'right' },
            ],
            rows: rows((i) => ({
              t: rowStamp(i), c: full(tokens.cached[i]), i: full(tokens.input[i]), o: full(tokens.output[i]),
            })),
          }}
        >
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
        </Card>

        <Card
          className="grid__wide"
          title="Token spend"
          value={currency(totals.cost)}
          legend={[
            { label: 'write cache', color: C.write, shape: 'rect' },
            { label: 'cached input', color: C.cached, shape: 'rect' },
            { label: 'output', color: C.output, shape: 'rect' },
            { label: 'input', color: C.input, shape: 'rect' },
            { label: 'other', color: C.other, shape: 'rect' },
          ]}
          activeSeries={active}
          onSeriesHover={setActive}
          footer={<AxisExtent from={from} to={to} />}
          table={{
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
          }}
        >
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
        </Card>

        <Card
          className="grid__wide"
          title="Cache savings"
          value={currency(totals.saved)}
          legend={[
            { label: 'without caching', color: C.counterfactual, shape: 'line' },
            { label: 'paid', color: C.paid, shape: 'line' },
          ]}
          activeSeries={active}
          onSeriesHover={setActive}
          footer={
            <>
              <AxisExtent from={from} to={to} />
              <p className="card-note">
                Cached input bills at a tenth of the input rate, so the grey line
                rebills those tokens at full price and drops the write-cache charges
                you would not have paid. Where grey dips below blue, writing the cache
                cost more than reading it saved.
                {totals.cacheHitRate == null ? '' : ` ${percent(totals.cacheHitRate)} of input tokens came from cache.`}
              </p>
            </>
          }
          table={{
            columns: [
              { key: 't', label: 'Time' },
              { key: 'p', label: 'Paid', align: 'right' },
              { key: 'w', label: 'Without caching', align: 'right' },
              { key: 's', label: 'Saved', align: 'right' },
            ],
            rows: rows((i) => ({
              t: rowStamp(i),
              p: currency(paid[i], 4),
              w: currency(withoutCache[i], 4),
              s: currency(withoutCache[i] - paid[i], 4),
            })),
          }}
        >
          <LineChart
            x={x}
            height={176}
            activeSeries={active}
            formatValue={(n) => currency(n, 4)}
            formatTick={(n) => `$${compact(n)}`}
            series={[
              { key: 'without', label: 'without caching', color: C.counterfactual, values: withoutCache, reducer: 'sum' },
              { key: 'paid', label: 'paid', color: C.paid, values: paid, reducer: 'sum' },
            ]}
          />
        </Card>

        <Card
          className="grid__wide"
          title="Models"
          table={{
            columns: [
              { key: 'm', label: 'Model' },
              { key: 'c', label: 'Spend', align: 'right' },
              { key: 't', label: 'Tokens', align: 'right' },
              { key: 'i', label: 'Input $/M', align: 'right' },
              { key: 'o', label: 'Output $/M', align: 'right' },
              { key: 'k', label: 'Cached', align: 'right' },
              { key: 'n', label: 'Executions', align: 'right' },
            ],
            rows: models.map((m) => ({
              m: m.model,
              c: currency(m.spend),
              t: full(m.tokens),
              i: m.inputRate == null ? '—' : currency(m.inputRate, 2),
              o: m.outputRate == null ? '—' : currency(m.outputRate, 2),
              k: m.cacheShare == null ? '—' : percent(m.cacheShare, 1),
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
                tokens: m.tokens,
                inputRate: m.inputRate,
                outputRate: m.outputRate,
                cacheShare: m.cacheShare,
              },
            }))}
            labelHeading="Model"
            valueHeading="Spend"
            columns={[
              { key: 'tokens', heading: 'Tokens', format: compact },
              { key: 'inputRate', heading: 'in $/M', format: (n) => `$${n.toFixed(2)}` },
              { key: 'outputRate', heading: 'out $/M', format: (n) => `$${n.toFixed(2)}` },
              { key: 'cacheShare', heading: 'cached', format: (n) => percent(n, 0), muted: true },
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
