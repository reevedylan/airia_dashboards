import { useEffect, useRef, useState } from 'react'
import { BarChart, RankChange, ToolbarButton } from './components'
import { Check, Copy } from './components/primitives/icons'
import { other, series, type SeriesSlot } from './theme/palette'
import {
  amount, sectionNotes, signedMoney, takeaways,
  type Ranked, type ReportFormat, type WeeklyReport as Report,
} from './data/airia'

export interface WeeklyReportProps {
  /** Null until the first fold for a report week lands. */
  report: Report | null
  /** A newer week is loading; the one shown is held, dimmed. */
  loading: boolean
  format: ReportFormat
  /** Who the figures are narrowed to, or null for all traffic. */
  scopeLabel: string | null
  zone: string
  /** Whose report this is, or null until the name is known. */
  tenant: string | null
  /** The same report as Markdown, for the copy button. */
  markdown: string | null
}

/**
 * Provider colours, by rank in the split. The order CLAUDE.md validates for
 * stacks — slot 4, yellow, sits next to orange and fails the colourblind
 * gate, so it is skipped. Past five providers the rest share the grey.
 */
const PROVIDER_SLOTS: readonly SeriesSlot[] = [1, 3, 2, 7, 5]
const providerColor = (i: number) => (i < PROVIDER_SLOTS.length ? series(PROVIDER_SLOTS[i]) : other)

/**
 * The weekly report, read top to bottom like a one-page memo.
 *
 * Deliberately NOT built from dashboard parts. The first version was a
 * grid of cards with a table in each, and read as a second dashboard — an
 * invitation to explore rather than a statement of what happened. This is
 * one column at reading width: a headline, then short sections that each
 * OPEN with their takeaway (see `takeaways()`), so skimming the headings
 * alone is the summary. Evidence under each is three rows at most; the
 * Markdown copy carries the complete lists.
 *
 * Every bar is neutral: which way spend went is shown by direction and
 * size, never by red and green, for the same reason the dashboard's deltas
 * are uncoloured. And every bar is drawn the way the dashboard's breakdown
 * draws it — the same track, colour and change mark — so the two pages read
 * as one product.
 */
export function WeeklyReport({ report: r, loading, format: f, scopeLabel, zone, tenant, markdown }: WeeklyReportProps) {
  if (!r) {
    return <p className="empty" role="status">Preparing the weekly report…</p>
  }

  const t = takeaways(r, f)
  const n = sectionNotes(r)
  const { x, now: daily, before: dailyBefore } = r.daily
  // "Tue 22 Sept" → "Tue 22": the month is in the kicker, and seven labels
  // have to fit under seven pairs of bars.
  const dayLabel = (d: number) => f.day(d).split(' ').slice(0, 2).join(' ')

  return (
    <article className="report" data-loading={loading ? '' : undefined} aria-label={`${tenant ? `${tenant} weekly report` : 'Weekly report'}, week of ${f.span(r.week)}`}>
      <header className="report__head">
        {/* Named here as well as in the page header: a report gets
            screenshotted and passed on, and the header may not come with it. */}
        <p className="report__kicker">
          {tenant ? <><span className="report__tenant">{tenant}</span> · </> : null}Week of {f.span(r.week)}
        </p>
        <h2 className="report__headline">{t.headline}</h2>
        {/* What happened, then why: the mover this names is always in a
            list below. */}
        <p className="report__why">{t.changes}</p>
        <dl className="report__figures">
          <Figure label="Spend" value={f.money(r.now.spend)} now={r.now.spend} before={r.before.spend} was={f.money(r.before.spend)} />
          <Figure label="Tokens" value={f.tokens(r.now.tokens)} now={r.now.tokens} before={r.before.tokens} was={f.tokens(r.before.tokens)} />
          <Figure label="Executions" value={f.count(r.now.executions)} now={r.now.executions} before={r.before.executions} was={f.count(r.before.executions)} />
        </dl>
        {markdown ? <CopyButton text={markdown} /> : null}
      </header>

      <Section title={t.daily}>
        <BarChart
          x={x}
          height={150}
          yTickCount={2}
          series={[{ key: 'now', label: 'This week', color: series(1), values: daily }]}
          ghost={{ label: 'Last week', values: dailyBefore }}
          ghostMark="pair"
          xLabel={dayLabel}
          formatValue={(n) => f.money(n)}
          formatTick={(n) => f.money(n).replace(/\.\d+$/, '')}
          formatX={f.day}
        />
        <p className="report__note">
          <span className="report__key report__key--bar" /> this week
          <span className="report__key report__key--ghost" /> last week
        </p>
      </Section>

      <Section title={t.users} note={n.users}>
        <Bars label="User" rows={r.lists.users} format={f} empty="No user spend this week." />
      </Section>

      <Section title={t.models} note={n.models}>
        <Bars label="Model" rows={r.lists.models} format={f} empty="No model spend this week." />
      </Section>

      <Section title={t.newAndDropped} note={n.newAndDropped}>
        <Arrivals r={r} format={f} />
      </Section>

      <Section title={t.providers}>
        {r.providers.length === 0 ? null : (
          <>
            <div className="report__split viz-rank__track" aria-hidden="true">
              {r.providers.map((p, i) => p.share > 0 ? (
                <span key={p.key} style={{ flexGrow: p.share, background: providerColor(i) }} />
              ) : null)}
            </div>
            {/* Names, shares and change written out, so identity never rests
                on colour alone. */}
            <div className="report__grid report__grid--providers">
              <p className="report__label report__head-row" aria-hidden="true">
                <span>Provider</span><span>Share</span><span>Spend</span><span>% change</span>
              </p>
              <ol className="report__rows">
                {r.providers.map((p, i) => (
                  <li key={p.key}>
                    <span className="report__name">
                      <span className="report__swatch" style={{ background: providerColor(i) }} aria-hidden="true" />
                      {p.key}
                    </span>
                    <span className="report__muted report__right">{f.pct(p.share)}</span>
                    <span className="report__num">{amount(p.spend, f)}</span>
                    <span className="report__right"><RankChange value={changeOf(p.spend, p.before)} /></span>
                  </li>
                ))}
              </ol>
            </div>
          </>
        )}
      </Section>

      <footer className="report__foot">
        Monday to Sunday, {zone}.{scopeLabel ? ` Filtered to ${scopeLabel}.` : ''} The Markdown copy has the full lists.
      </footer>
    </article>
  )
}

/** A change as a fraction for `RankChange`: new from nothing, null when
 *  there was nothing either week. */
const changeOf = (now: number, before: number): number | 'new' | null =>
  before > 0 ? (now - before) / before : now > 0 ? 'new' : null

/** One of the three headline measures, with its change and last week's. */
function Figure({ label, value, now, before, was }: { label: string; value: string; now: number; before: number; was: string }) {
  return (
    <div className="report__figure">
      <dt>{label}</dt>
      <dd>
        <span className="report__figval">{value}</span>
        <RankChange value={changeOf(now, before)} />
      </dd>
      <dd className="report__figwas">was {was}</dd>
    </div>
  )
}

/** A takeaway heading, the line saying what its rows are, then the rows. */
function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="report__section">
      <h3 className="report__takeaway">{title}</h3>
      {note ? <p className="report__sub">{note}</p> : null}
      {children}
    </section>
  )
}

/**
 * Name, share of the week's total, spend, and change in dollars and per
 * cent — the dashboard's breakdown row, plus the dollar figure that says
 * how much a change MATTERED: −82% of $2 and −82% of $500 are not the same
 * news. One list per dimension, so a name never appears twice with two
 * kinds of change. The bar is a share of the TOTAL, never of the largest
 * row.
 */
function Bars({ label, rows, format: f, empty }: { label: string; rows: Ranked[]; format: ReportFormat; empty: string }) {
  if (rows.length === 0) return <p className="report__none">{empty}</p>
  return (
    <div className="report__grid report__grid--bars">
      <p className="report__label report__head-row" aria-hidden="true">
        <span>{label}</span><span>Share of total</span><span>Spend</span><span>$ change</span><span>% change</span>
      </p>
      <ol className="report__rows">
        {rows.map((e) => (
          <li key={e.key}>
            {/* A departure is listed at $0 and −100%, which says it; it is
                also under "no longer used" below. */}
            <span className="report__name" title={e.key}>{e.key}</span>
            <span className="viz-rank__share">
              <span className="viz-rank__track" aria-hidden="true">
                <span className="viz-rank__bar" data-some={e.spend > 0 ? '' : undefined} style={{ width: `${e.share * 100}%` }} />
              </span>
              <span className="viz-rank__pct">{f.pct(e.share)}</span>
            </span>
            <span className="report__num">{amount(e.spend, f)}</span>
            <span className="report__right report__muted report__tab">{signedMoney(e.change, f.money)}</span>
            <span className="report__right"><RankChange value={changeOf(e.spend, e.before)} /></span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * New and no longer used, side by side.
 *
 * Grouped by kind, each kind under its own count, so the heading's "5 new
 * models, 2 new gateways" can be found in the rows beneath it. The first
 * version was one mixed list cut at three rows: the gateways the heading
 * promised sat inside an "and 4 more" that could have belonged to either
 * group, and every row repeated "Model" and a badge. Now the column says
 * which side a row is on, and every row is listed: an arrival or a
 * departure is exactly what a reader scans this section for, so none is
 * hidden behind a "more".
 */
function Arrivals({ r, format: f }: { r: Report; format: ReportFormat }) {
  const kinds = (g: Report['added']) => [
    { kind: 'Models', rows: g.models.map((e) => ({ key: e.key, name: e.key, spend: e.spend })) },
    { kind: 'Users', rows: g.users.map((e) => ({ key: e.key, name: e.key, spend: e.spend })) },
    { kind: 'Gateways', rows: g.gateways.map((e) => ({ key: e.key, name: f.gateway(e.key), spend: e.spend })) },
  ].filter((k) => k.rows.length > 0)
  const sides = [
    { title: 'New', amount: 'This week', kinds: kinds(r.added), none: 'Nothing new.' },
    { title: 'No longer used', amount: 'Last week', kinds: kinds(r.removed), none: 'Nothing stopped.' },
  ]
  if (sides.every((s) => s.kinds.length === 0)) return null
  return (
    <div className="report__arrivals">
      {sides.map((side) => (
        <div className="report__side" key={side.title}>
          <p className="report__label report__sidehead">
            <span>{side.title}</span>
            <span>{side.amount}</span>
          </p>
          {side.kinds.length === 0 ? <p className="report__none">{side.none}</p> : side.kinds.map((k) => {
            return (
              <div className="report__kind" key={k.kind}>
                <p className="report__kindhead">{k.kind} <span className="report__muted">· {k.rows.length}</span></p>
                <ol className="report__rows report__rows--arrivals">
                  {k.rows.map((e) => (
                    <li key={e.key}>
                      <span className="report__name" title={e.name}>{e.name}</span>
                      <span className="report__num">{amount(e.spend, f)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/**
 * Copies the report as Markdown.
 *
 * The clipboard API needs a secure context and permission, and a headless or
 * locked-down browser may refuse it; the old `execCommand` path is the
 * fallback, and failing both says so on the button rather than in the
 * console.
 */
function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const settle = (next: 'copied' | 'failed') => {
    setState(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 2000)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      settle('copied')
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      let ok = false
      try { ok = document.execCommand('copy') } catch { ok = false }
      area.remove()
      settle(ok ? 'copied' : 'failed')
    }
  }

  return (
    <span className="report__copy">
      <ToolbarButton size="sm" icon={state === 'copied' ? <Check size={13} /> : <Copy size={13} />} onClick={copy}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy as Markdown'}
      </ToolbarButton>
    </span>
  )
}
