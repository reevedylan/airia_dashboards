import { useMemo, useState } from 'react'
import {
  Card, AxisExtent, LineChart, BarChart, RankTable, StatTile,
  TimeRangeBar, ToolbarButton, FilterIcon, SavedIcon,
  type RangeKey,
} from './components'
import { series } from './theme/palette'
import { axisDate, compact, currency, full, grainFor, percent, stamp } from './lib/format'
import { useAiria, sliceRange, MIN_RATE_DENOMINATOR } from './data/airia'
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
  rate: series(1),
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

  const { x, tokens, cost, balanceUsed, executions, cacheHitRate, models, totals } = slice
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

  const cacheDenominator = tokens.input.map((v, i) => v + tokens.cached[i])
  const passthrough = totals.cost === 0 ? null : 1 - totals.balanceUsed / totals.cost
  const anyBalance = balanceUsed.some((v) => v > 0)

  return (
    <div className="page">
      <Head />
      {toolbar}

      <div className="strip">
        <StatTile label="Token spend" value={currency(totals.cost)} />
        <StatTile label="Tokens" value={compact(totals.tokens)} />
        <StatTile
          label="Balance used"
          value={currency(totals.balanceUsed)}
          delta={passthrough == null ? undefined : {
            text: `${percent(passthrough, 0)} passthrough`,
            good: true,
            vs: 'customer credentials',
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
          title="Cache hit rate"
          value={totals.cacheHitRate == null ? '—' : percent(totals.cacheHitRate)}
          footer={
            <>
              <AxisExtent from={from} to={to} />
              <p className="card-note">
                Cached share of input tokens, weighted by volume. Buckets under{' '}
                {compact(MIN_RATE_DENOMINATOR)} input tokens are left blank rather than
                plotted as a rate. The headline figure covers the whole range.
              </p>
            </>
          }
          table={{
            columns: [
              { key: 't', label: 'Time' },
              { key: 'r', label: 'Cache hit rate', align: 'right' },
              { key: 'n', label: 'Executions', align: 'right' },
            ],
            rows: rows((i) => ({
              t: rowStamp(i),
              r: cacheHitRate[i] == null ? '—' : percent(cacheHitRate[i]!),
              n: full(executions[i]),
            })),
          }}
        >
          <LineChart
            x={x}
            height={176}
            zeroBased={false}
            formatValue={(n) => percent(n)}
            formatTick={(n) => percent(n, 0)}
            series={[{
              key: 'rate',
              label: 'cache hit rate',
              color: C.rate,
              values: cacheHitRate,
              area: true,
              // Weight by the ratio's own denominator, so a quiet bucket with
              // one uncached request cannot drag the line to 0% alongside a
              // bucket carrying ten thousand cached tokens.
              weights: cacheDenominator,
            }]}
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
              { key: 'n', label: 'Executions', align: 'right' },
            ],
            rows: models.map((m) => ({
              m: m.model, c: currency(m.cost), t: full(m.tokens), n: full(m.executions),
            })),
          }}
        >
          <RankTable
            rows={models.map((m) => ({
              key: m.model,
              label: m.model,
              value: m.cost,
              secondary: m.tokens,
              // Counted-token cost over counted tokens. Using total cost here
              // would divide write-cache charges by a denominator that excludes
              // write-cache tokens, inflating low-volume models without bound.
              tertiary: m.tokens === 0 ? undefined : (m.costTokens / m.tokens) * 1_000_000,
            }))}
            labelHeading="Model"
            valueHeading="Spend"
            secondaryHeading="Tokens"
            tertiaryHeading="$/M tok"
            limit={6}
            formatValue={(n) => currency(n)}
            formatSecondary={compact}
            formatTertiary={(n) => `$${n.toFixed(2)}`}
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
        {!anyBalance ? ' · every execution in this range ran on customer credentials, so balance used is zero throughout' : ''}
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
