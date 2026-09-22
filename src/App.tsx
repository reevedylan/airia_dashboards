import { useMemo, useState } from 'react'
import {
  Card, AxisExtent, LineChart, BarChart, RankTable, StatTile,
  TimeRangeBar, ToolbarButton,
  type RangeKey,
} from './components'
import { series } from './theme/palette'
import { bucketFormat, compact, currency, full, share } from './lib/format'
import { useAiria, summarise, runningTotal, modelRows, breakdownFor } from './data/airia'
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
} as const

export default function App() {
  const [range, setRange] = useState<RangeKey>('3M')
  const [hovered, setHovered] = useState<string | null>(null)
  const [tokenView, setTokenView] = useState<ChartView>('daily')
  const [spendView, setSpendView] = useState<ChartView>('daily')
  /** One model isolated across BOTH charts — the Models table is the single
   *  filter source, so isolating never applies to one chart alone. */
  const [isolated, setIsolated] = useState<string | null>(null)
  const [theme, setTheme] = useTheme()
  const load = useAiria()

  /* The ingest already bucketed each range to its own bar size and count, so
     selecting a range is a lookup rather than a slice-and-downsample. */
  const block = load.status === 'ready' ? load.data.ranges[range] : null
  const slice = useMemo(() => (block ? summarise(block) : null), [block])
  const models = useMemo(() => (block ? modelRows(block) : []), [block])

  /* A model with traffic in 3M may have none in 24H, so an isolation that no
     longer matches anything is dropped rather than showing an empty chart. */
  const active = isolated && models.some((m) => m.model === isolated) ? isolated : null
  const isolatedRow = active ? models.find((m) => m.model === active) ?? null : null
  const breakdown = useMemo(
    () => (block && active ? breakdownFor(block, active) : null),
    [block, active],
  )

  /* Labels come from the bucket size and the zone the buckets were aligned
     to, not from the chart's total span. */
  const fmtX = useMemo(
    () => (block ? bucketFormat(block.bucketMs, block.zone) : null),
    [block],
  )

  /** Each bucket's end is its neighbour's start, so a daylight-saving day's
   *  23- or 25-hour bucket is labelled with its real span. */
  const labelAt = useMemo(() => {
    if (!block || !fmtX) return () => ''
    const next = new Map(block.x.map((t, i) => [t, block.x[i + 1] ?? t + block.bucketMs]))
    return (t: number) => fmtX.label(t, next.get(t) ?? t + block.bucketMs)
  }, [block, fmtX])

  const toolbar = (
    <TimeRangeBar
      value={range}
      onChange={setRange}
      actions={
        <ToolbarButton icon={<ThemeIcon />} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </ToolbarButton>
      }
    />
  )

  if (load.status !== 'ready' || !slice || !block || !fmtX) {
    return (
      <div className="page">
        <Head />
        {toolbar}
        <EmptyState state={load} />
      </div>
    )
  }

  const { x, executions } = block
  /* While isolated, the charts stack that model's own categories and the
     unfiltered whole sits behind as a ghost. */
  const tokens = breakdown ? breakdown.tokens : block.tokens
  const cost = breakdown ? breakdown.cost : block.cost
  const { totals } = slice
  const from = fmtX.tick(x[0])
  const to = fmtX.tick(x[x.length - 1])
  const rowStamp = (i: number) => labelAt(x[i])

  /* Table twins are sampled to a readable length. Sampling every Nth bucket
     would be near-useless here: only ~9% of five-minute buckets contain any
     execution, so a flat stride lands almost entirely on empty ones and the
     table reads as a column of zeros. Sample the ACTIVE buckets instead, so
     the twin actually carries the values the chart is showing. */
  /* Cumulative views accumulate from zero at the start of the SELECTED window,
     so they reset on every range change rather than running all-time. */
  /* Per-bucket totals of WHAT IS PLOTTED — the isolated model when one is
     selected, every model otherwise. Deriving the cumulative series from the
     all-models summary instead meant clicking a model changed the daily bars
     but left the cumulative line untouched. */
  const shownTokens = x.map((_, i) => tokens.input[i] + tokens.cached[i] + tokens.output[i])
  const shownPaid = x.map((_, i) =>
    cost.input[i] + cost.cached[i] + cost.output[i] + cost.write[i] + cost.other[i])
  const tokenCumulative = runningTotal(shownTokens)
  const spendCumulative = runningTotal(shownPaid)

  /* The unfiltered whole, for the grey reference behind an isolated series.
     Daily compares per-bucket totals; cumulative compares running totals. */
  const allTokens = block.x.map((_, i) =>
    block.tokens.input[i] + block.tokens.cached[i] + block.tokens.output[i])
  const allPaid = block.x.map((_, i) =>
    block.cost.input[i] + block.cost.cached[i] + block.cost.output[i] +
    block.cost.write[i] + block.cost.other[i])

  const ghostOf = (values: number[], cumulative: boolean) =>
    breakdown
      ? {
          label: 'all models',
          values: cumulative ? runningTotal(values) : values,
          // A running total must not be re-summed when buckets merge.
          reducer: (cumulative ? 'max' : 'sum') as 'max' | 'sum',
        }
      : undefined

  /* The card's headline figure follows the chart. Showing the window total
     while the plot shows one model would misstate it by the isolated model's
     share; the KPI strip above keeps the all-models totals. */
  const tokenHeadline = breakdown ? shownTokens.reduce((p, c) => p + c, 0) : totals.tokens
  const spendHeadline = breakdown ? shownPaid.reduce((p, c) => p + c, 0) : totals.cost

  const bucketNote = `One bar per ${bucketLabel(block.bucketMs)} · ${block.zone}`
  const cumNote = `Running total from zero · ${bucketLabel(block.bucketMs)} steps · ${block.zone}`
  const isolationNote = isolatedRow
    ? `${isolatedRow.model} — ${share(isolatedRow.shareTokens)} of tokens, ` +
      `${share(isolatedRow.shareSpend)} of spend · grey is all models`
    : null

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
          value={compact(tokenHeadline)}
          controls={<ViewToggle value={tokenView} onChange={setTokenView} />}
          legend={tokenView === 'daily'
            ? [
                { label: 'cached input', color: C.cached, shape: 'rect' },
                { label: 'input', color: C.input, shape: 'rect' },
                { label: 'output', color: C.output, shape: 'rect' },
              ]
            : []}
          activeSeries={hovered}
          onSeriesHover={setHovered}
          footer={
            <>
              <AxisExtent from={from} to={to} />
              <p className="card-note" data-isolated={isolationNote ? '' : undefined}>
                {isolationNote ?? (tokenView === 'daily' ? bucketNote : cumNote)}
              </p>
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
                  ...(breakdown ? [{ key: 'a', label: 'All models', align: 'right' as const }] : []),
                ],
                rows: rows((i) => ({
                  t: rowStamp(i),
                  c: full(tokenCumulative[i]),
                  ...(breakdown ? { a: full(runningTotal(allTokens)[i]) } : {}),
                })),
              }}
        >
          {tokenView === 'daily' ? (
            <BarChart
              x={x}
              reducer="sum"
              activeSeries={hovered}
              height={176}
              formatValue={(n) => full(n)}
              formatX={labelAt}
              formatTick={compact}
              series={[
                { key: 'cached', label: 'cached input', color: C.cached, values: tokens.cached },
                { key: 'input', label: 'input', color: C.input, values: tokens.input },
                { key: 'output', label: 'output', color: C.output, values: tokens.output },
              ]}
              ghost={ghostOf(allTokens, false)}
            />
          ) : (
            <LineChart
              x={x}
              height={176}
              activeSeries={hovered}
              formatValue={(n) => full(Math.round(n))}
              formatX={labelAt}
              formatTick={compact}
              series={[
                // 'max' not 'sum': a running total must not be re-summed if
                // buckets are ever merged for display. It is monotonic, so the
                // largest value in a bucket is its closing value.
                { key: 'total', label: 'cumulative', color: C.total, values: tokenCumulative, reducer: 'max', area: true },
              ]}
              ghost={ghostOf(allTokens, true)}
            />
          )}
        </Card>

        <Card
          className="grid__wide"
          title="Token spend"
          value={currency(spendHeadline)}
          controls={<ViewToggle value={spendView} onChange={setSpendView} />}
          legend={spendView === 'daily'
            ? [
                { label: 'write cache', color: C.write, shape: 'rect' },
                { label: 'cached input', color: C.cached, shape: 'rect' },
                { label: 'output', color: C.output, shape: 'rect' },
                { label: 'input', color: C.input, shape: 'rect' },
                { label: 'other', color: C.other, shape: 'rect' },
              ]
            : []}
          activeSeries={hovered}
          onSeriesHover={setHovered}
          footer={
            <>
              <AxisExtent from={from} to={to} />
              <p className="card-note" data-isolated={isolationNote ? '' : undefined}>
                {isolationNote ?? (spendView === 'daily' ? bucketNote : cumNote)}
              </p>
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
                  ...(breakdown ? [{ key: 'a', label: 'All models', align: 'right' as const }] : []),
                ],
                rows: rows((i) => ({
                  t: rowStamp(i),
                  c: currency(spendCumulative[i]),
                  ...(breakdown ? { a: currency(runningTotal(allPaid)[i]) } : {}),
                })),
              }}
        >
          {spendView === 'daily' ? (
            <BarChart
              x={x}
              reducer="sum"
              activeSeries={hovered}
              height={176}
              formatValue={(n) => currency(n, 4)}
              formatX={labelAt}
              formatTick={(n) => `$${compact(n)}`}
              series={[
                { key: 'write', label: 'write cache', color: C.write, values: cost.write },
                { key: 'cached', label: 'cached input', color: C.cached, values: cost.cached },
                { key: 'output', label: 'output', color: C.output, values: cost.output },
                { key: 'input', label: 'input', color: C.input, values: cost.input },
                { key: 'other', label: 'other', color: C.other, values: cost.other },
              ]}
              ghost={ghostOf(allPaid, false)}
            />
          ) : (
            <LineChart
              x={x}
              height={176}
              activeSeries={hovered}
              formatValue={(n) => currency(n)}
              formatX={labelAt}
              formatTick={(n) => `$${compact(n)}`}
              series={[
                { key: 'total', label: 'cumulative', color: C.total, values: spendCumulative, reducer: 'max', area: true },
              ]}
              ghost={ghostOf(allPaid, true)}
            />
          )}
        </Card>


        <Card
          className="grid__full"
          title="Models"
          controls={
            active ? (
              <ToolbarButton size="sm" icon={<ClearIcon />} onClick={() => setIsolated(null)}>
                Show all models
              </ToolbarButton>
            ) : undefined
          }
          table={{
            columns: [
              { key: 'm', label: 'Model' },
              { key: 'c', label: 'Spend', align: 'right' },
              { key: 'cs', label: '% spend', align: 'right' },
              { key: 'ti', label: 'Tokens in', align: 'right' },
              { key: 'to', label: 'Tokens out', align: 'right' },
              { key: 'ts', label: '% tokens', align: 'right' },
              { key: 'i', label: 'Input $/M', align: 'right' },
              { key: 'o', label: 'Output $/M', align: 'right' },
              { key: 'n', label: 'Executions', align: 'right' },
            ],
            rows: models.map((m) => ({
              m: m.model,
              c: currency(m.spend),
              cs: share(m.shareSpend),
              ti: full(m.tokensIn),
              to: full(m.tokensOut),
              ts: share(m.shareTokens),
              i: m.inputRate == null ? '—' : currency(m.inputRate, 2),
              o: m.outputRate == null ? '—' : currency(m.outputRate, 2),
              n: full(m.executions),
            })),
          }}
          footer={
            <p className="card-note">
              {active
                ? 'Both charts are showing this model only. Click the row again, or "Show all models", to return to the combined view.'
                : 'Click a model to show it on its own in both charts, with the all-models total behind it.'}
            </p>
          }
        >
          <RankTable
            rows={models.map((m) => ({
              key: m.model,
              label: m.model,
              value: m.spend,
              cells: {
                shareSpend: m.shareSpend,
                tokensIn: m.tokensIn,
                tokensOut: m.tokensOut,
                shareTokens: m.shareTokens,
                inputRate: m.inputRate,
                outputRate: m.outputRate,
              },
            }))}
            labelHeading="Model"
            valueHeading="Spend"
            selectedKey={active}
            onSelect={setIsolated}
            columns={[
              { key: 'shareSpend', heading: '% spend', format: (n) => share(n), muted: true },
              { key: 'tokensIn', heading: 'Tokens in', format: compact },
              { key: 'tokensOut', heading: 'Tokens out', format: compact },
              { key: 'shareTokens', heading: '% tokens', format: (n) => share(n), muted: true },
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
        {load.data.meta.amountsMismatched > 0 ? ` (${load.data.meta.amountsMismatched} do not)` : ''} ·
        {' '}generated {new Date(load.data.meta.generatedAt).toLocaleString('en-GB')}
      </p>

      <PaletteSheet />
    </div>
  )
}

/** "15 min", "2 hr", "1 day" — however the range's buckets are sized. */
function bucketLabel(ms: number): string {
  if (ms % 86_400_000 === 0) { const d = ms / 86_400_000; return d === 1 ? '1 day' : `${d} days` }
  if (ms % 3_600_000 === 0) { const h = ms / 3_600_000; return h === 1 ? '1 hr' : `${h} hr` }
  return `${ms / 60_000} min`
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

const ClearIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
)

const ThemeIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="8" r="3.1" />
    <path d="M8 1.4v1.4M8 13.2v1.4M14.6 8h-1.4M2.8 8H1.4M12.7 3.3l-1 1M4.3 11.7l-1 1M12.7 12.7l-1-1M4.3 4.3l-1-1" />
  </svg>
)
