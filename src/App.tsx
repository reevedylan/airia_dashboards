import { useMemo, useState } from 'react'
import {
  Card, AxisExtent, LineChart, BarChart, RankTable, StatTile,
  TimeRangeBar, ToolbarButton, MultiSelect, Tabs,
  type RangeKey,
} from './components'
import { series } from './theme/palette'
import { bucketFormat, compact, currency, full, share } from './lib/format'
import {
  useAiria, useAllUsers, seriesFor, breakdown, runningTotal,
  type Dimension, type BreakdownRow,
} from './data/airia'
import { PaletteSheet } from './demo/PaletteSheet'
import { useTheme } from './lib/theme'

/**
 * Colours are assigned to measures by identity, once — never by rank or array
 * position — so changing the range or filtering never repaints the survivors.
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

/** One isolation at a time across both breakdowns, so the charts never try to
 *  render two ghost overlays at once. */
type Isolate = { dim: Dimension; key: string } | null

const DIM_LABEL: Record<Dimension, string> = { model: 'models', user: 'users' }

export default function App() {
  const [range, setRange] = useState<RangeKey>('3M')
  const [tokenView, setTokenView] = useState<ChartView>('daily')
  const [spendView, setSpendView] = useState<ChartView>('daily')
  const [hovered, setHovered] = useState<string | null>(null)
  /** Empty means every user — a filter that excludes nothing, not everything. */
  const [userFilter, setUserFilter] = useState<Set<string>>(new Set())
  const [isolate, setIsolate] = useState<Isolate>(null)
  const [tab, setTab] = useState<Dimension>('model')
  const [theme, setTheme] = useTheme()

  const load = useAiria()
  const data = load.status === 'ready' ? load.data : null
  const allUsers = useAllUsers(data)
  const block = data ? data.ranges[range] : null

  /* The user filter is a SCOPE: everything below derives from `scoped`, so the
     KPI tiles, both charts and both breakdowns all recompute together. */
  const scoped = useMemo(
    () => (block ? seriesFor(block, { users: userFilter }) : null),
    [block, userFilter],
  )
  const modelRows = useMemo(
    () => (block ? breakdown(block, 'model', userFilter) : []),
    [block, userFilter],
  )
  const userRows = useMemo(
    () => (block ? breakdown(block, 'user', userFilter) : []),
    [block, userFilter],
  )

  /* An isolation that no longer matches anything in scope is dropped rather
     than left to render an empty chart — a model or user present in 3M may
     have nothing in 24H, and a user filter can exclude one outright. */
  const rowsFor = (dim: Dimension) => (dim === 'model' ? modelRows : userRows)
  const activeRow: BreakdownRow | null =
    isolate ? rowsFor(isolate.dim).find((r) => r.key === isolate.key) ?? null : null
  const active = activeRow ? isolate : null

  /* Isolation stacks on top of the user scope, so the grey ghost is the
     filtered whole, never the unfiltered dashboard total. */
  const shown = useMemo(() => {
    if (!block) return null
    if (!active) return scoped
    return seriesFor(block, {
      users: userFilter,
      model: active.dim === 'model' ? active.key : undefined,
      user: active.dim === 'user' ? active.key : undefined,
    })
  }, [block, scoped, active, userFilter])

  const fmtX = useMemo(() => (block ? bucketFormat(block.bucketMs, block.zone) : null), [block])
  const labelAt = useMemo(() => {
    if (!block || !fmtX) return () => ''
    const next = new Map(block.x.map((t, i) => [t, block.x[i + 1] ?? t + block.bucketMs]))
    return (t: number) => fmtX.label(t, next.get(t) ?? t + block.bucketMs)
  }, [block, fmtX])

  const serviceKey = data?.meta.serviceKeyLabel ?? 'Standard Key (service)'

  const toolbar = (
    <TimeRangeBar
      value={range}
      onChange={setRange}
      filters={
        <MultiSelect
          label="User"
          options={allUsers}
          selected={userFilter}
          onToggle={(v) => setUserFilter((prev) => {
            const next = new Set(prev)
            if (next.has(v)) next.delete(v)
            else next.add(v)
            return next
          })}
          onChange={setUserFilter}
          allLabel="All users"
          placeholder="Search users…"
          renderOption={(v) => (v === serviceKey ? <em>{v}</em> : v)}
        />
      }
      actions={
        <ToolbarButton icon={<ThemeIcon />} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </ToolbarButton>
      }
    />
  )

  if (!block || !scoped || !shown || !fmtX) {
    return (
      <div className="page">
        <Head />
        {toolbar}
        <EmptyState state={load} />
      </div>
    )
  }

  const { x } = block
  const tokens = shown.tokens
  const cost = shown.cost
  const from = fmtX.tick(x[0])
  const to = fmtX.tick(x[x.length - 1])
  const rowStamp = (i: number) => labelAt(x[i])

  const tokenCumulative = runningTotal(shown.tokenTotals)
  const spendCumulative = runningTotal(scoped === shown ? shown.paid : shown.paid)

  /* The ghost is the current scope's whole — shown only while isolated. */
  const ghostOf = (values: number[], cumulative: boolean) =>
    active
      ? {
          label: `all ${DIM_LABEL[active.dim]}`,
          values: cumulative ? runningTotal(values) : values,
          // A running total must not be re-summed when buckets merge.
          reducer: (cumulative ? 'max' : 'sum') as 'max' | 'sum',
        }
      : undefined

  const bucketNote = `One bar per ${bucketLabel(block.bucketMs)} · ${block.zone}`
  const cumNote = `Running total from zero · ${bucketLabel(block.bucketMs)} steps · ${block.zone}`
  const isolationNote = activeRow
    ? `${activeRow.key} — ${share(activeRow.shareTokens)} of tokens, ` +
      `${share(activeRow.shareSpend)} of spend · grey is all ${DIM_LABEL[isolate!.dim]}`
    : null

  /* Table twins sample the buckets that contain activity: only a fraction of
     buckets are busy, so a flat stride would return a column of zeros. */
  const activeBuckets = x.map((_, i) => i).filter((i) => shown.executions[i] > 0)
  const tableStride = Math.max(1, Math.floor(activeBuckets.length / 120))
  const rows = <T,>(fmt: (i: number) => T) =>
    activeBuckets.filter((_, n) => n % tableStride === 0).map(fmt)

  const breakdownRows = rowsFor(tab)
  const shareColumns = [
    { key: 'shareSpend', heading: '% spend', format: (n: number) => share(n), muted: true, sortable: true },
    { key: 'tokensIn', heading: 'Tokens in', format: compact, sortable: true },
    { key: 'tokensOut', heading: 'Tokens out', format: compact, sortable: true },
    { key: 'shareTokens', heading: '% tokens', format: (n: number) => share(n), muted: true, sortable: true },
    { key: 'inputRate', heading: 'in $/M', format: (n: number) => `$${n.toFixed(2)}`, sortable: true },
    { key: 'outputRate', heading: 'out $/M', format: (n: number) => `$${n.toFixed(2)}`, sortable: true },
  ]

  return (
    <div className="page">
      <Head />
      {toolbar}

      {userFilter.size > 0 ? (
        <p className="page__scope">
          Scoped to {userFilter.size === 1 ? [...userFilter][0] : `${userFilter.size} users`} ·
          {' '}everything below is recomputed against {userFilter.size === 1 ? 'their' : 'their combined'} data.
          <button type="button" onClick={() => setUserFilter(new Set())}>Clear</button>
        </p>
      ) : null}

      <div className="strip">
        <StatTile label="Token spend" value={currency(scoped.totals.cost)} />
        <StatTile label="Tokens" value={compact(scoped.totals.tokens)} />
        <StatTile label="Executions" value={full(scoped.totals.executions)} />
      </div>

      <div className="grid">
        <Card
          className="grid__wide"
          title="Tokens"
          value={compact(shown.totals.tokens)}
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
                  ...(active ? [{ key: 'a', label: `All ${DIM_LABEL[active.dim]}`, align: 'right' as const }] : []),
                ],
                rows: rows((i) => ({
                  t: rowStamp(i),
                  c: full(tokenCumulative[i]),
                  ...(active ? { a: full(runningTotal(scoped.tokenTotals)[i]) } : {}),
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
              ghost={ghostOf(scoped.tokenTotals, false)}
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
              ghost={ghostOf(scoped.tokenTotals, true)}
            />
          )}
        </Card>

        <Card
          className="grid__wide"
          title="Token spend"
          value={currency(shown.totals.cost)}
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
                  ...(active ? [{ key: 'a', label: `All ${DIM_LABEL[active.dim]}`, align: 'right' as const }] : []),
                ],
                rows: rows((i) => ({
                  t: rowStamp(i),
                  c: currency(spendCumulative[i]),
                  ...(active ? { a: currency(runningTotal(scoped.paid)[i]) } : {}),
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
              ghost={ghostOf(scoped.paid, false)}
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
              ghost={ghostOf(scoped.paid, true)}
            />
          )}
        </Card>

        {/* One card, two dimensions. They share a column set and the same
            isolate/ghost behaviour — only the grouping differs. */}
        <Card
          className="grid__full"
          title="Breakdown"
          hideTitle
          controls={
            <>
              <Tabs
                ariaLabel="Breakdown dimension"
                value={tab}
                onChange={setTab}
                tabs={[{ key: 'model', label: 'By model' }, { key: 'user', label: 'By user' }]}
              />
              {active ? (
                <ToolbarButton size="sm" icon={<ClearIcon />} onClick={() => setIsolate(null)}>
                  Show all {DIM_LABEL[active.dim]}
                </ToolbarButton>
              ) : null}
            </>
          }
          table={{
            columns: [
              { key: 'k', label: tab === 'model' ? 'Model' : 'User' },
              { key: 'c', label: 'Spend', align: 'right' },
              { key: 'cs', label: '% spend', align: 'right' },
              { key: 'ti', label: 'Tokens in', align: 'right' },
              { key: 'to', label: 'Tokens out', align: 'right' },
              { key: 'ts', label: '% tokens', align: 'right' },
              { key: 'i', label: 'Input $/M', align: 'right' },
              { key: 'o', label: 'Output $/M', align: 'right' },
              { key: 'n', label: 'Executions', align: 'right' },
            ],
            rows: breakdownRows.map((r) => ({
              k: r.key,
              c: currency(r.spend),
              cs: share(r.shareSpend),
              ti: full(r.tokensIn),
              to: full(r.tokensOut),
              ts: share(r.shareTokens),
              i: r.inputRate == null ? '—' : currency(r.inputRate, 2),
              o: r.outputRate == null ? '—' : currency(r.outputRate, 2),
              n: full(r.executions),
            })),
          }}
          footer={
            <p className="card-note">
              {active
                ? `Both charts are showing this ${active.dim} only. Click the row again, or "Show all ${DIM_LABEL[active.dim]}", to return to the combined view.`
                : `Click a ${tab} to show it on its own in both charts, with the all-${DIM_LABEL[tab]} total behind it.`}
              {tab === 'user' ? ` Requests made with the tenant's standard service key rather than an individual's are grouped as ${serviceKey}.` : ''}
              {tab === 'user' && userFilter.size > 0
                ? ' This list is scoped by the User filter too — use the filter above to change the selection.'
                : ''}
            </p>
          }
        >
          {/* Keyed by dimension so switching tabs resets sort, search and
              expansion: a sort by "out $/M" on models is not a sort anyone
              asked for on users, and it silently overrode the default. */}
          <RankTable
            key={tab}
            rows={breakdownRows.map((r) => ({
              key: r.key,
              label: r.key,
              value: r.spend,
              cells: {
                shareSpend: r.shareSpend,
                tokensIn: r.tokensIn,
                tokensOut: r.tokensOut,
                shareTokens: r.shareTokens,
                inputRate: r.inputRate,
                outputRate: r.outputRate,
              },
            }))}
            labelHeading={tab === 'model' ? 'Model' : 'User'}
            valueHeading="Spend"
            columns={shareColumns}
            limit={6}
            sortable
            searchable
            searchPlaceholder={tab === 'model' ? 'Search models…' : 'Search users…'}
            selectedKey={active?.dim === tab ? active.key : null}
            onSelect={(key) => setIsolate(key == null ? null : { dim: tab, key })}
            formatValue={(n) => currency(n)}
          />
        </Card>
      </div>

      <p className="page__note">
        {data!.meta.source} executions only · {full(data!.meta.rowCount)} rows
        ingested, {full(data!.meta.amountsReconciled)} of which reconcile exactly
        {data!.meta.amountsMismatched > 0 ? ` (${data!.meta.amountsMismatched} do not)` : ''} ·
        {' '}generated {new Date(data!.meta.generatedAt).toLocaleString('en-GB')}
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
        <pre>AIRIA_API_KEY=akey_… node scripts/ingest-airia.mjs</pre>
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
