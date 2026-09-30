import { useCallback, useMemo, useState } from 'react'
import {
  Card, RankTable, StatTile, TimeRangeBar, ToolbarButton,
  MultiSelect, Tabs, KeyGate, RANGE_SPANS, type RangeKey,
} from './components'
import { ChartCard, type ChartView } from './ChartCard'
import { series } from './theme/palette'
import { bucketFormat, compact, currency, full, grainName, share } from './lib/format'
import {
  useAiriaLive, useAllUsers, seriesFor, breakdown,
  previousTotals, delta, dayOf, stepWindow, oldestEndDay, retentionFloor,
  stepRange, rangeDays, RETENTION_DAYS, useAllGateways, useGatewayNames,
  windowSpanMs, nativeGrain, windowDays, ZONE,
  type Dimension, type BreakdownRow, type History, type DayRange, type Scope, type GrainPick,
} from './data/airia'
import { gatewayLabel, gatewayTitle, hasGatewayNames } from './lib/airia/gateways'
import { NO_GATEWAY, grainOptions } from './lib/airia/aggregate'
import { useApiKey, maskKey } from './lib/apiKey'
import { useTheme } from './lib/theme'
import { Moon, Sun, X } from './components/primitives/icons'

/**
 * Colours are assigned to measures by identity, once — never by rank or array
 * position — so changing the range or filtering never repaints the survivors.
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
  total: series(1),
} as const

/** One isolation at a time across both breakdowns, so the charts never try to
 *  render two ghost overlays at once. */
type Isolate = { dim: Dimension; key: string } | null

const DIM_LABEL: Record<Dimension, string> = { model: 'models', user: 'users', gateway: 'gateways', provider: 'providers' }

export default function App() {
  const [range, setRange] = useState<RangeKey>('7D')
  const [tokenView, setTokenView] = useState<ChartView>('cumulative')
  const [spendView, setSpendView] = useState<ChartView>('cumulative')
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
  /**
   * The grain the reader picked, or null for each window's own.
   *
   * Kept across a change of range and applied wherever it fits — hourly
   * suits 24H, 7D and 14D alike — but never forced onto a window it does not
   * suit: across 90 days hourly is 2,160 bars, so that window falls back to
   * its default and picks the choice back up on the way out. The same rule
   * isolation follows.
   */
  const [grainPick, setGrainPick] = useState<number | null>(null)
  const [recent, setRecent] = useRecentRanges()
  const [theme, setTheme] = useTheme()

  const native = nativeGrain(range, custom)
  const grainChoices = grainOptions(windowSpanMs(range, custom), native)
  const grain = grainPick != null && grainChoices.includes(grainPick) ? grainPick : native
  /* Only a grain that differs from the default costs a re-fold. */
  const grainFold: GrainPick | null = grain === native ? null : { window: custom ? 'custom' : range, bucketMs: grain }

  const { key, setKey, clear, remember } = useApiKey()
  /* One step back is the likeliest next click; the first load reaches that
     far so it is already cached. A drawn range steps by its own span and is
     never what the page opens on, so it passes nothing. */
  const stepBack = custom ? null : stepWindow(range, anchor, -1)
  const load = useAiriaLive(key, anchor, custom, grainFold, stepBack)
  /* The last good fold, HELD while the next one loads. Reading it only when
     the status is 'ready' is what used to drop the page back to the key gate
     mid-session, the moment an anchor reached past the cached rows. */
  const data = load.data
  const busy = load.status === 'loading'
  const allUsers = useAllUsers(data)
  const gwNames = useGatewayNames(key)
  const gwLabel = useCallback((id: string) => gatewayLabel(id, gwNames), [gwNames])
  /* Sorted by what they READ as, not by their ids — an id-ordered list of
     names looks shuffled. Re-sorts when the names land. */
  const allGatewayIds = useAllGateways(data)
  const allGateways = useMemo(
    () => [...allGatewayIds].sort((a, b) => gwLabel(a).localeCompare(gwLabel(b))),
    [allGatewayIds, gwLabel],
  )
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
    provider: block ? breakdown(block, 'provider', scope) : [],
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
      provider: active.dim === 'provider' ? active.key : undefined,
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
  const hasNames = hasGatewayNames(gwNames)

  /* Duration is the time picker; the pager moves that window through time.
     Stepping is in the window's OWN length — the preset's, or the drawn
     span for a custom range — so a step back lands on the window
     immediately before this one. */
  const today = dayOf(Date.now())
  const floorDay = dayOf(retentionFloor())
  /* Both ends of the window being ASKED FOR, never the fold still on
     screen: while a step loads the page holds the previous one, and mixing
     its start with the new end made the pager flicker through a span that
     was neither. The controls lead, the plot catches up. Re-derived when a
     fold lands, so a live window's start follows the clock. */
  const generatedAt = data?.meta.generatedAt
  const preset = useMemo(
    () => windowDays(range, anchor, custom ? null : grain),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, anchor, custom ? null : grain, generatedAt],
  )
  const endDay = custom ? custom.to : preset.to
  const startDay = custom ? custom.from : preset.from
  /* Airia's logs expire at a year, so no window may reach past that. For a
     preset the bound is on the whole span, not the date clicked: a 90D
     window ending one day inside retention would be mostly empty. */
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
    window: { from: startDay, to: endDay },
  }

  const pickerControls = {
    /* An absolute range is a custom window, so it leaves preset mode. Both
       ends arrive already ordered; the data layer turns them into local
       midnight and the last millisecond of the closing day. */
    onApply: (from: string, to: string) => {
      setCustom({ from, to })
      setRecent((prev) => [{ from, to }, ...prev.filter((r) => r.from !== from || r.to !== to)].slice(0, RECENT_MAX))
    },
    /* Recent ranges that have since aged past retention cannot be picked. */
    recent: recent.filter((r) => r.from >= floorDay),
    today,
    minDay: floorDay,
    maxSpanDays: RETENTION_DAYS,
    zone: ZONE,
    offset: zoneOffset(ZONE),
  }

  const grainControls = {
    value: grain,
    options: grainChoices.map((g) => ({ value: g, label: grainName(g), hint: g === native ? 'default' : undefined })),
    onChange: setGrainPick,
  }

  const toolbar = (
    <TimeRangeBar
      /* Nothing is pressed while a custom range is showing: a preset and a
         drawn range are alternatives, not layers. */
      value={custom ? null : range}
      onChange={selectPreset}
      anchor={anchorControls}
      picker={pickerControls}
      grain={grainControls}
      filters={
        <>
          <MultiSelect
            label="Filter users"
            noun="users"
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
              label="Filter gateways"
              noun="gateways"
              options={allGateways}
              selected={gatewayFilter}
              onToggle={(v) => setGatewayFilter(toggle(v))}
              onChange={setGatewayFilter}
              allLabel="All gateways"
              placeholder="Search gateways…"
              optionText={gwLabel}
              renderOption={(v) => <span title={gatewayTitle(v, gwNames)}>{gwLabel(v)}</span>}
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
          <ToolbarButton icon={theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
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
    const period = custom ? plural(rangeDays(custom), 'day') : RANGE_SPANS[range]
    return d ? { ...d, vs: `vs previous ${period}` } : undefined
  }

  const bucketNote = `One bar per ${bucketLabel(block.bucketMs)} · ${block.zone}`
  const cumNote = `Running total from zero · ${bucketLabel(block.bucketMs)} steps · ${block.zone}`
  const isolationNote = activeRow
    ? `${isolate!.dim === 'gateway' ? gwLabel(activeRow.key) : activeRow.key} — ${share(activeRow.shareTokens)} of tokens, ` +
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
              : gatewayFilter.size === 1 ? `gateway ${gwLabel([...gatewayFilter][0])}`
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
          No period comparison here: the {custom ? plural(rangeDays(custom), 'day') : RANGE_SPANS[range]} before this one is older than
          Airia's {RETENTION_DAYS}-day retention, so there is nothing left to compare against.
        </p>
      )}

      <div className="grid">
        {/* Both cards are the same component. What differs is the measure:
            its categories, its formatters and the note under the plot. */}
        <ChartCard
          className="grid__wide"
          loading={busy}
          title="Token spend"
          value={currency(shown.totals.cost)}
          view={spendView}
          onView={setSpendView}
          x={x}
          series={[
            { key: 'write', label: 'write cache', color: C.write, values: cost.write },
            { key: 'cached', label: 'cached input', color: C.cached, values: cost.cached },
            { key: 'output', label: 'output', color: C.output, values: cost.output },
            { key: 'input', label: 'input', color: C.input, values: cost.input },
            { key: 'other', label: 'other', color: C.other, values: cost.other },
          ]}
          lineColor={C.total}
          totals={shown.paid}
          ghostTotals={active ? scoped.paid : null}
          ghostLabel={active ? `all ${DIM_LABEL[active.dim]}` : undefined}
          formatValue={(n) => currency(n, 4)}
          formatTotal={(n) => currency(n)}
          formatTick={(n) => `$${compact(n)}`}
          formatX={labelAt}
          tableRows={rows}
          note={isolationNote ?? (spendView === 'period' ? bucketNote : cumNote)}
          from={from}
          to={to}
          activeSeries={hovered}
          onSeriesHover={setHovered}
        />

        <ChartCard
          className="grid__wide"
          loading={busy}
          title="Tokens"
          value={compact(shown.totals.tokens)}
          view={tokenView}
          onView={setTokenView}
          x={x}
          series={[
            { key: 'cached', label: 'cached input', color: C.cached, values: tokens.cached },
            { key: 'input', label: 'input', color: C.input, values: tokens.input },
            { key: 'output', label: 'output', color: C.output, values: tokens.output },
          ]}
          lineColor={C.write}
          totals={shown.tokenTotals}
          ghostTotals={active ? scoped.tokenTotals : null}
          ghostLabel={active ? `all ${DIM_LABEL[active.dim]}` : undefined}
          formatValue={(n) => full(Math.round(n))}
          formatTick={compact}
          formatX={labelAt}
          tableRows={rows}
          note={isolationNote ?? (tokenView === 'period' ? bucketNote : cumNote)}
          from={from}
          to={to}
          activeSeries={hovered}
          onSeriesHover={setHovered}
        />

        {/* One card, four dimensions. They share a column set and the same
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
                  { key: 'provider', label: 'By provider' },
                ]}
              />
              {active ? (
                <ToolbarButton size="sm" icon={<X size={13} />} onClick={() => setIsolate(null)}>
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
              k: tab === 'gateway' ? gwLabel(r.key) : r.key,
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
              {tab === 'gateway'
                ? ` One row per gateway configuration. Calls from before gateways were recorded are grouped as ${NO_GATEWAY}.` +
                  (hasNames
                    ? ' A row showing a short id is a configuration that no longer exists — its traffic is still counted.'
                    : ' Names could not be loaded for this key, so each row shows the first block of its id.')
                : ''}
              {tab === 'provider' ? ' Grouped by the provider that served the call, so a Claude model reached through Bedrock counts under Bedrock rather than Anthropic.' : ''}
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
              label: tab === 'gateway' ? gwLabel(r.key) : r.key,
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
    </div>
  )
}

const DIM_HEADING: Record<Dimension, string> = { model: 'Model', user: 'User', gateway: 'Gateway', provider: 'Provider' }

/** A relative toggle: computing the next Set from a prop loses one of two
 *  toggles landing in the same render batch. */
const toggle = (value: string) => (prev: Set<string>): Set<string> => {
  const next = new Set(prev)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

/** How many recently used absolute ranges the picker remembers. */
const RECENT_MAX = 4
const RECENT_STORE = 'viz-recent-ranges'

/**
 * Recently used absolute ranges, remembered in this browser.
 *
 * `localStorage` rather than state alone, because "the range I looked at
 * yesterday" is the point of the list. Only civil days are stored — no
 * tenant data, and nothing about the key. Every access is guarded: storage
 * can be blocked or come back empty, and the list is a convenience.
 */
function useRecentRanges() {
  const [recent, setRecent] = useState<DayRange[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENT_STORE) ?? '[]')
      return Array.isArray(raw)
        ? raw.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r?.from) && /^\d{4}-\d{2}-\d{2}$/.test(r?.to)).slice(0, RECENT_MAX)
        : []
    } catch { return [] }
  })
  const update = useCallback((fn: (prev: DayRange[]) => DayRange[]) => {
    setRecent((prev) => {
      const next = fn(prev)
      try { localStorage.setItem(RECENT_STORE, JSON.stringify(next)) } catch { /* convenience only */ }
      return next
    })
  }, [])
  return [recent, update] as const
}

/** "UTC+10:00" — the zone's offset right now, as the picker's footer shows it. */
function zoneOffset(zone: string): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  return part === 'GMT' ? 'UTC+00:00' : part.replace('GMT', 'UTC')
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


