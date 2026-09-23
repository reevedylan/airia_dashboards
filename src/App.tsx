import { useMemo, useState } from 'react'
import {
  Card, AxisExtent, LineChart, BarChart, RankTable, StatTile,
  TimeRangeBar, ToolbarButton, MultiSelect, Tabs, KeyGate,
  type RangeKey,
} from './components'
import { series } from './theme/palette'
import { bucketFormat, compact, currency, full, share } from './lib/format'
import {
  useAiriaLive, useAllUsers, seriesFor, breakdown, runningTotal,
  previousTotals, delta, dayOf, endOfDay, stepWindow, oldestEndDay, retentionFloor,
  stepRange, rangeDays, RETENTION_DAYS, useAllGateways, useGatewayNames,
  type Dimension, type BreakdownRow, type History, type DayRange, type Scope,
} from './data/airia'
import { gatewayLabel, gatewayTitle } from './lib/airia/gateways'
import { NO_GATEWAY } from './lib/airia/aggregate'
import { useApiKey, maskKey } from './lib/apiKey'
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

const DIM_LABEL: Record<Dimension, string> = { model: 'models', user: 'users', gateway: 'gateways' }

export default function App() {
  const [range, setRange] = useState<RangeKey>('3M')
  const [tokenView, setTokenView] = useState<ChartView>('daily')
  const [spendView, setSpendView] = useState<ChartView>('daily')
  const [hovered, setHovered] = useState<string | null>(null)
  /** Empty means every user — a filter that excludes nothing, not everything. */
  const [userFilter, setUserFilter] = useState<Set<string>>(new Set())
  /** Same contract for gateways: empty is ALL, so unticking the last one
   *  cannot blank the dashboard. */
  const [gatewayFilter, setGatewayFilter] = useState<Set<string>>(new Set())
  const [isolate, setIsolate] = useState<Isolate>(null)
  const [tab, setTab] = useState<Dimension>('model')
  /** Where the window ENDS. null means the live, ending-now window. */
  const [anchor, setAnchor] = useState<number | null>(null)
  /**
   * A window drawn on the calendar instead of chosen from the presets.
   * Mutually exclusive with them: setting one clears the other, so the
   * toolbar never shows two answers to "which window is this".
   */
  const [custom, setCustom] = useState<DayRange | null>(null)
  const [theme, setTheme] = useTheme()

  const { key, setKey, clear, remember } = useApiKey()
  const load = useAiriaLive(key, anchor, custom)
  /* The last good fold, HELD while the next one loads. Reading it only when
     the status is 'ready' is what used to drop the page back to the key gate
     mid-session, the moment an anchor reached past the cached rows. */
  const data = load.data
  const busy = load.status === 'loading'
  const allUsers = useAllUsers(data)
  const allGateways = useAllGateways(data)
  const gwNames = useGatewayNames(key)
  const block = data ? (custom ? data.ranges.custom ?? null : data.ranges[range]) : null

  /* The filters are SCOPES: everything below derives from `scope`, so the
     KPI tiles, both charts and all three breakdowns recompute together.
     They intersect — picking two users and one gateway means those users'
     traffic ON that gateway. */
  const scope: Scope = useMemo(
    () => ({ users: userFilter, gateways: gatewayFilter }),
    [userFilter, gatewayFilter],
  )
  const scoped = useMemo(() => (block ? seriesFor(block, scope) : null), [block, scope])
  const rowsByDim = useMemo(() => ({
    model: block ? breakdown(block, 'model', scope) : [],
    user: block ? breakdown(block, 'user', scope) : [],
    gateway: block ? breakdown(block, 'gateway', scope) : [],
  }), [block, scope])

  /* An isolation that no longer matches anything in scope is dropped rather
     than left to render an empty chart — a model or user present in 3M may
     have nothing in 24H, and a user filter can exclude one outright. */
  const rowsFor = (dim: Dimension) => rowsByDim[dim]
  const activeRow: BreakdownRow | null =
    isolate ? rowsFor(isolate.dim).find((r) => r.key === isolate.key) ?? null : null
  const active = activeRow ? isolate : null

  /* Isolation stacks on top of the user scope, so the grey ghost is the
     filtered whole, never the unfiltered dashboard total. */
  const shown = useMemo(() => {
    if (!block) return null
    if (!active) return scoped
    return seriesFor(block, {
      ...scope,
      model: active.dim === 'model' ? active.key : undefined,
      user: active.dim === 'user' ? active.key : undefined,
      gateway: active.dim === 'gateway' ? active.key : undefined,
    })
  }, [block, scoped, active, scope])

  const fmtX = useMemo(() => (block ? bucketFormat(block.bucketMs, block.zone) : null), [block])
  /**
   * Tick labels drop the year, which is right until a window spans two of
   * them — "23 Sept – 22 Sept" is not a range anyone can read. A custom
   * range can be a whole year, so both ends say which one.
   */
  const extentLabel = useMemo(() => {
    if (!block || !fmtX) return () => ''
    const first = block.x[0]
    const last = block.x[block.x.length - 1]
    const crossesYear = new Date(first).getFullYear() !== new Date(last).getFullYear()
    return (t: number) => (crossesYear ? `${fmtX.tick(t)} ${new Date(t).getFullYear()}` : fmtX.tick(t))
  }, [block, fmtX])
  const labelAt = useMemo(() => {
    if (!block || !fmtX) return () => ''
    const next = new Map(block.x.map((t, i) => [t, block.x[i + 1] ?? t + block.bucketMs]))
    return (t: number) => fmtX.label(t, next.get(t) ?? t + block.bucketMs)
  }, [block, fmtX])

  const serviceKey = data?.meta.serviceKeyLabel ?? 'Standard Key (service)'
  /** Whether the name lookup came back with anything — the gateway tab says
   *  so, rather than leaving a column of hex unexplained. */
  const hasNames = Object.keys(gwNames).length > 0

  /* Duration is the range buttons; the anchor moves that window through
     time. Stepping is in the range's OWN units — calendar months for 1M and
     3M, the drawn span for a custom range — so a step back lands on the
     window immediately before this one. */
  const today = dayOf(Date.now())
  const floorDay = dayOf(retentionFloor())
  /* The last instant the window includes, and the day it falls on. While
     loading, these describe the window being fetched rather than the one
     still on screen — the controls lead, the plot catches up. */
  const endDay = custom ? custom.to : dayOf(anchor ?? Date.now())
  const startDay = custom ? custom.from : (block ? dayOf(block.x[0]) : endDay)
  /* Airia's logs expire at a year, so no window may reach past that. For a
     preset the bound is on the whole span, not the date clicked: a 3M
     window ending one day inside retention would be two-thirds empty. */
  const oldestDay = custom ? addDaysISO(floorDay, rangeDays(custom) - 1) : oldestEndDay(range)
  const atNow = custom ? custom.to >= today : anchor == null

  /** A preset always means "this duration, ending now" — it discards any
   *  anchor and leaves custom mode. The two are one control, not two. */
  const selectPreset = (next: RangeKey) => {
    setRange(next)
    setAnchor(null)
    setCustom(null)
  }

  const anchorControls = {
    atNow,
    atOldest: endDay <= oldestDay,
    custom: custom != null,
    onStep: (dir: -1 | 1) => {
      if (custom) setCustom((prev) => (prev ? stepRange(prev, dir) : prev))
      else setAnchor((prev) => stepWindow(range, prev, dir))
    },
    /* Any calendar selection is a custom window — that is what the picker
       is for now — so it leaves preset mode. Both ends arrive already
       ordered; the data layer turns them into local midnight and the last
       millisecond of the closing day. */
    onSelectRange: (from: string, to: string) => setCustom({ from, to }),
    /* "Now" means the live window of whichever preset is selected, which
       is also the way out of custom mode. */
    onNow: () => { setAnchor(null); setCustom(null) },
    /* The END of the window, not the start of its last bucket. With a
       multi-day grain those differ: a 1 Mar – 31 Aug range buckets in twos
       and its last bar STARTS on the 30th, which made the chip disagree
       with the dates that were actually picked. */
    resolved: block
      ? `${extentLabel(block.x[0])} – ${extentLabel(custom ? endOfDay(custom.to) : block.x[block.x.length - 1])}`
      : undefined,
    stale: busy,
    window: { from: startDay, to: endDay },
    maxDay: today,
    minDay: floorDay,
    maxSpanDays: RETENTION_DAYS,
    note: `Whole days, ${block?.zone ?? 'local time'}. The bar size follows the span.`,
  }

  const toolbar = (
    <TimeRangeBar
      /* Nothing is pressed while a custom range is showing: a preset and a
         drawn range are alternatives, not layers. */
      value={custom ? null : range}
      onChange={selectPreset}
      anchor={anchorControls}
      filters={
        <>
          <MultiSelect
            label="User"
            options={allUsers}
            selected={userFilter}
            onToggle={(v) => setUserFilter(toggle(v))}
            onChange={setUserFilter}
            allLabel="All users"
            placeholder="Search users…"
            renderOption={(v) => (v === serviceKey ? <em>{v}</em> : v)}
          />
          {/* Only worth showing once there is more than one to choose
              between — a filter with a single option is furniture. */}
          {allGateways.length > 1 ? (
            <MultiSelect
              label="Gateway"
              icon={<GatewayIcon />}
              options={allGateways}
              selected={gatewayFilter}
              onToggle={(v) => setGatewayFilter(toggle(v))}
              onChange={setGatewayFilter}
              allLabel="All gateways"
              placeholder="Search gateways…"
              renderOption={(v) => <span title={gatewayTitle(v, gwNames)}>{gatewayLabel(v, gwNames)}</span>}
            />
          ) : null}
        </>
      }
      actions={
        <>
          {key ? (
            <span className="viz-keychip">
              <code>{maskKey(key)}</code>
              {remember ? null : <span title="Held in memory only">· this tab</span>}
              <button type="button" onClick={clear}>Change key</button>
            </span>
          ) : null}
          <ToolbarButton icon={<ThemeIcon />} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? 'Light' : 'Dark'}
          </ToolbarButton>
        </>
      }
    />
  )

  /*
   * The gate answers exactly two questions: is there a key, and was it
   * rejected. Everything else — a backfill, a re-fold, a dropped connection
   * — is handled by holding the previous render, because throwing someone
   * back to a password prompt mid-session reads as being logged out.
   */
  const rejected = load.status === 'error' && load.auth
  if (!key || rejected || !block || !scoped || !shown || !fmtX) {
    const progress = busy
      ? (load.progress && load.progress.total > 0
          ? `${load.message} ${load.progress.done}/${load.progress.total} · ${full(load.progress.rows)} rows`
          : load.message ?? null)
      : null
    return (
      <div className="page">
        <Head />
        <KeyGate
          onSubmit={(k, persist) => setKey(k, persist)}
          busy={progress}
          error={load.status === 'error' ? load.message ?? null : null}
        />
      </div>
    )
  }

  const { x } = block
  const tokens = shown.tokens
  const cost = shown.cost
  const from = extentLabel(x[0])
  const to = extentLabel(x[x.length - 1])
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

  /* The KPI tiles compare against the window immediately before this one, of
     equal length, scoped by the same user filter. Deliberately independent of
     isolate, which is a view on the charts only. */
  const prev = previousTotals(block, scope)
  /* A comparison window that reaches past the retention limit is not a
     comparison: the rows are gone, so the baseline is short by however much
     expired, and the tile would report a rise that is really a deletion. */
  const comparable = block.previous.from >= retentionFloor()
  const vsPrevious = (now: number, before: number) => {
    if (!comparable) return undefined
    const d = delta(now, before)
    // Direction and magnitude only. More spend is not inherently good or bad,
    // so colouring the arrow would assert a judgement the number cannot make.
    const period = custom ? plural(rangeDays(custom), 'day') : range
    return d ? { ...d, vs: `vs previous ${period}` } : undefined
  }

  const bucketNote = `One bar per ${bucketLabel(block.bucketMs)} · ${block.zone}`
  const cumNote = `Running total from zero · ${bucketLabel(block.bucketMs)} steps · ${block.zone}`
  const isolationNote = activeRow
    ? `${isolate!.dim === 'gateway' ? gatewayLabel(activeRow.key, gwNames) : activeRow.key} — ${share(activeRow.shareTokens)} of tokens, ` +
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

      {/* A refetch holds the page rather than replacing it, so the only
          thing that changes is this line and the opacity of the plots. */}
      {busy ? (
        <p className="page__busy" role="status">
          <ProgressBar value={load.progress ? load.progress.done / Math.max(1, load.progress.total) : null} />
          <span>
            {load.message}
            {load.progress && load.progress.total > 0
              ? ` · ${load.progress.done}/${load.progress.total} days · ${full(load.progress.rows)} rows`
              : ''}
          </span>
        </p>
      ) : null}

      {/* Not an auth failure — the key is fine, the request was not. The
          figures below are the last complete ones, so they stay. */}
      {load.status === 'error' ? (
        <p className="page__error" role="alert">
          {load.message} · showing the last complete window.
        </p>
      ) : null}

      {userFilter.size > 0 || gatewayFilter.size > 0 ? (
        <p className="page__scope">
          Scoped to {[
            userFilter.size === 0 ? null
              : userFilter.size === 1 ? [...userFilter][0] : `${userFilter.size} users`,
            gatewayFilter.size === 0 ? null
              : gatewayFilter.size === 1 ? `gateway ${gatewayLabel([...gatewayFilter][0], gwNames)}`
              : `${gatewayFilter.size} gateways`,
          ].filter(Boolean).join(' on ')} ·
          {' '}everything below is recomputed against that traffic alone.
          <button
            type="button"
            onClick={() => { setUserFilter(new Set()); setGatewayFilter(new Set()) }}
          >
            Clear
          </button>
        </p>
      ) : null}

      <div className="strip" data-loading={busy ? '' : undefined}>
        <StatTile label="Token spend" value={currency(scoped.totals.cost)} delta={vsPrevious(scoped.totals.cost, prev.spend)} />
        <StatTile label="Tokens" value={compact(scoped.totals.tokens)} delta={vsPrevious(scoped.totals.tokens, prev.tokens)} />
        <StatTile label="Executions" value={full(scoped.totals.executions)} delta={vsPrevious(scoped.totals.executions, prev.executions)} />
      </div>

      {comparable ? null : (
        <p className="page__hint">
          No period comparison here: the {custom ? plural(rangeDays(custom), 'day') : range} before this one is older than
          Airia's {RETENTION_DAYS}-day retention, so there is nothing left to compare against.
        </p>
      )}

      <div className="grid">
        <Card
          className="grid__wide"
          loading={busy}
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
          loading={busy}
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
          loading={busy}
          title="Breakdown"
          hideTitle
          controls={
            <>
              <Tabs
                ariaLabel="Breakdown dimension"
                value={tab}
                onChange={setTab}
                tabs={[
                  { key: 'model', label: 'By model' },
                  { key: 'user', label: 'By user' },
                  ...(allGateways.length > 1 ? [{ key: 'gateway' as const, label: 'By gateway' }] : []),
                ]}
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
              { key: 'k', label: DIM_HEADING[tab] },
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
              k: tab === 'gateway' ? gatewayLabel(r.key, gwNames) : r.key,
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
              {tab === 'gateway' ? ` One row per gateway configuration. Calls from before gateways were recorded are grouped as ${NO_GATEWAY}${hasNames ? '' : ', and the rest are shown by the first block of their id'}.` : ''}
              {(userFilter.size > 0 || gatewayFilter.size > 0)
                ? ' This list is scoped by the filters above too.'
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
              label: tab === 'gateway' ? gatewayLabel(r.key, gwNames) : r.key,
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
            labelHeading={DIM_HEADING[tab]}
            valueHeading="Spend"
            columns={shareColumns}
            limit={6}
            sortable
            searchable
            searchPlaceholder={`Search ${DIM_LABEL[tab]}…`}
            selectedKey={active?.dim === tab ? active.key : null}
            onSelect={(key) => setIsolate(key == null ? null : { dim: tab, key })}
            formatValue={(n) => currency(n)}
          />
        </Card>
      </div>

      <p className="page__note">
        {data!.meta.source} executions only · {full(data!.meta.rowCount)} of{' '}
        {full(data!.meta.fetchedCount)} fetched rows, {full(data!.meta.amountsReconciled)} of
        which reconcile exactly
        {data!.meta.amountsMismatched > 0 ? ` (${data!.meta.amountsMismatched} do not)` : ''}
        {data!.meta.legacyTotals > 0
          ? `, ${full(data!.meta.legacyTotals)} of them against the pre-June-2026 total convention`
          : ''} ·
        {' '}generated {new Date(data!.meta.generatedAt).toLocaleString('en-GB')}
        {load.history ? <> · <HistoryNote history={load.history} /></> : null}
      </p>

      <PaletteSheet />
    </div>
  )
}

const DIM_HEADING: Record<Dimension, string> = { model: 'Model', user: 'User', gateway: 'Gateway' }

/** A relative toggle: computing the next Set from a prop loses one of two
 *  toggles landing in the same render batch. */
const toggle = (value: string) => (prev: Set<string>): Set<string> => {
  const next = new Set(prev)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

/** "1 day", "31 days" — a count always reads beside its unit. */
const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`

/** Civil-day arithmetic for the one place App needs it. */
const addDaysISO = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
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

/**
 * How far back stepping is instant. Worth saying: the window can reach
 * further than the cache, it just costs a fetch to get there.
 */
function HistoryNote({ history }: { history: History }) {
  return (
    <>
      {full(history.rows)} rows held, back to {dayOf(history.from)}
      {history.running ? ' and still reaching back' : ''}
    </>
  )
}

/** Determinate when the fetch knows its window count, a pulse when it does not. */
function ProgressBar({ value }: { value: number | null }) {
  return (
    <span className="page__progress" data-indeterminate={value == null ? '' : undefined} aria-hidden="true">
      <span style={value == null ? undefined : { width: `${Math.round(value * 100)}%` }} />
    </span>
  )
}

function Head() {
  return (
    <header className="page__head">
      <h1>Gateway usage</h1>
    </header>
  )
}

const ClearIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
)

/** A hub with spokes: several routes through one door. */
const GatewayIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="6.25" width="12" height="7.25" rx="1.75" />
    <path d="M5.25 6.25V4.5a2.75 2.75 0 015.5 0v1.75M8 9v1.75" />
  </svg>
)

const ThemeIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="8" r="3.1" />
    <path d="M8 1.4v1.4M8 13.2v1.4M14.6 8h-1.4M2.8 8H1.4M12.7 3.3l-1 1M4.3 11.7l-1 1M12.7 12.7l-1-1M4.3 4.3l-1-1" />
  </svg>
)
