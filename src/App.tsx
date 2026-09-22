import { useMemo, useState } from 'react'
import {
  Card, AxisExtent, LineChart, BarChart, DonutChart, RankTable,
  TimeRangeBar, ToolbarButton, FilterIcon, SavedIcon,
  type RangeKey,
} from './components'
import { series, status } from './theme/palette'
import { axisDate, compact, currency, currencyCompact, full, grainFor, seconds, stamp } from './lib/format'
import { buildTelemetry, COUNTRIES, MODELS, errorBreakdown } from './data/generate'
import { useTheme } from './lib/theme'
import { PaletteSheet } from './demo/PaletteSheet'

/** Fixed "now" so the demo is reproducible. */
const NOW = Date.UTC(2026, 4, 23, 12, 0, 0)

/* Colour assignment, made once and by identity — never by rank, so a filter
   that drops a series never repaints the survivors. */
const COLORS = {
  success: series(1),
  error: status.critical,   // reserved status colour, used for a real error state
  cost: series(1),
  latency: series(3),
  code500: series(1),
  code400: series(2),
  code401: series(3),
} as const

export default function App() {
  const [range, setRange] = useState<RangeKey>('3M')
  const [active, setActive] = useState<string | null>(null)
  const [theme, setTheme] = useTheme()

  const data = useMemo(() => buildTelemetry(range, NOW), [range])
  const grain = useMemo(() => grainFor(data.x[data.x.length - 1] - data.x[0]), [data])
  const from = axisDate(data.x[0], grain)
  const to = axisDate(data.x[data.x.length - 1], grain)

  const errorSlices = useMemo(
    () => errorBreakdown(data.totals.errors).map((e) => ({
      key: e.key,
      label: e.label,
      value: e.value,
      color: e.key === '500' ? COLORS.code500 : e.key === '400' ? COLORS.code400 : COLORS.code401,
    })),
    [data.totals.errors],
  )

  /* Every chart ships a table twin. Sampled to a readable stride — the
     tooltip and the chart cover the rest. Rows carry a time component
     whenever the stride is sub-daily, so no two rows share a stamp. */
  const stride = Math.max(1, Math.floor(data.x.length / 120))
  const strideMs = (data.x[1] - data.x[0]) * stride
  const rowStamp = (i: number) => stamp(data.x[i], strideMs < 86_400_000)
  const timeRows = (fmt: (i: number) => Record<string, string>) =>
    data.x.filter((_, i) => i % stride === 0).map((_, j) => fmt(j * stride))

  return (
    <div className="page">
      <header className="page__head">
        <h1>Dashboard</h1>
      </header>

      <TimeRangeBar
        value={range}
        onChange={setRange}
        actions={
          <>
            <ToolbarButton icon={<FilterIcon />}>Show Filters</ToolbarButton>
            <ToolbarButton icon={<SavedIcon />}>Saved Filters</ToolbarButton>
            <ToolbarButton
              icon={<ThemeIcon />}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? 'Light' : 'Dark'}
            </ToolbarButton>
          </>
        }
      />

      <div className="grid">
        <Card
          className="grid__wide"
          title="Requests"
          value={full(data.totals.requests)}
          legend={[
            { label: 'success', color: COLORS.success, shape: 'line' },
            { label: 'error', color: COLORS.error, shape: 'line' },
          ]}
          activeSeries={active}
          onSeriesHover={setActive}
          footer={<AxisExtent from={from} to={to} />}
          table={{
            columns: [
              { key: 't', label: 'Time' },
              { key: 's', label: 'Success', align: 'right' },
              { key: 'e', label: 'Errors', align: 'right' },
            ],
            rows: timeRows((i) => ({
              t: rowStamp(i),
              s: full(data.success[i]),
              e: full(data.errors[i]),
            })),
          }}
        >
          <LineChart
            x={data.x}
            activeSeries={active}
            series={[
              { key: 'success', label: 'success', color: COLORS.success, values: data.success },
              { key: 'error', label: 'error', color: COLORS.error, values: data.errors },
            ]}
            height={176}
          />
        </Card>

        <Card
          title="Errors"
          /* Legend keys by status code — the full description would overflow
             the card. The name stays in the tooltip, the centre readout and
             the table view. */
          legend={errorSlices.map((s) => ({ label: s.key, color: s.color, shape: 'rect' as const }))}
          activeSeries={active}
          onSeriesHover={setActive}
          table={{
            columns: [
              { key: 'code', label: 'Status' },
              { key: 'n', label: 'Errors', align: 'right' },
            ],
            rows: errorSlices.map((s) => ({ code: s.label, n: full(s.value) })),
          }}
        >
          <DonutChart
            data={errorSlices}
            centreLabel="Total errors"
            activeSeries={active}
            height={214}
            formatValue={(n) => full(n)}
          />
        </Card>

        <Card
          title="Top Models"
          table={{
            columns: [
              { key: 'm', label: 'Model' },
              { key: 'n', label: 'Requests', align: 'right' },
            ],
            rows: MODELS.map((m) => ({ m: m.label, n: full(m.value) })),
          }}
        >
          <RankTable rows={MODELS} labelHeading="Name" valueHeading="Requests" limit={6} />
        </Card>

        <Card
          title="Costs"
          value={currency(data.totals.cost)}
          footer={<AxisExtent from={from} to={to} />}
          table={{
            columns: [
              { key: 't', label: 'Time' },
              { key: 'c', label: 'Cost', align: 'right' },
            ],
            rows: timeRows((i) => ({ t: rowStamp(i), c: currency(data.cost[i], 3) })),
          }}
        >
          <BarChart
            x={data.x}
            series={[{ key: 'cost', label: 'costs', color: COLORS.cost, values: data.cost }]}
            reducer="sum"
            formatValue={currencyCompact}
            formatTick={(n) => `$${compact(n)}`}
            height={176}
          />
        </Card>

        <Card
          title="Top Countries"
          table={{
            columns: [
              { key: 'c', label: 'Country' },
              { key: 'n', label: 'Requests', align: 'right' },
            ],
            rows: COUNTRIES.map((c) => ({ c: c.label, n: full(c.value) })),
          }}
        >
          <RankTable rows={COUNTRIES} labelHeading="Country" valueHeading="Requests" limit={5} />
        </Card>

        <Card
          className="grid__wide"
          title="Latency"
          value={seconds(data.totals.latency)}
          valueSuffix="/ req"
          footer={<AxisExtent from={from} to={to} />}
          table={{
            columns: [
              { key: 't', label: 'Time' },
              { key: 'l', label: 'Latency', align: 'right' },
            ],
            rows: timeRows((i) => ({ t: rowStamp(i), l: seconds(data.latency[i]) })),
          }}
        >
          <LineChart
            x={data.x}
            series={[{ key: 'latency', label: 'latency', color: COLORS.latency, values: data.latency, area: true }]}
            formatValue={(n) => seconds(n)}
            formatTick={(n) => `${n.toFixed(1)}s`}
            zeroBased={false}
            height={176}
          />
        </Card>
      </div>

      <PaletteSheet />

      <p className="page__note">
        Showing {compact(data.x.length)} samples per series · charts reduce to
        the densest resolution the card can paint, then hold that shape at any
        range.
      </p>
    </div>
  )
}

const ThemeIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="8" r="3.1" />
    <path d="M8 1.4v1.4M8 13.2v1.4M14.6 8h-1.4M2.8 8H1.4M12.7 3.3l-1 1M4.3 11.7l-1 1M12.7 12.7l-1-1M4.3 4.3l-1-1" />
  </svg>
)
