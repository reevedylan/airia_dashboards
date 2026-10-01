import { useEffect, useRef, useState } from 'react'
import { AxisExtent, BarChart, ToolbarButton } from './components'
import { Check, Copy } from './components/primitives/icons'
import { other, series, type SeriesSlot } from './theme/palette'
import {
  amount, headlineContext, moverName, sectionNotes, signedMoney, takeaways, topMoves,
  type Entry, type Mover, type ReportFormat, type WeeklyReport as Report,
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

/** How many names an inline list shows before "and N more". */
const INLINE = 3

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
 * are uncoloured.
 */
export function WeeklyReport({ report: r, loading, format: f, scopeLabel, zone, markdown }: WeeklyReportProps) {
  if (!r) {
    return <p className="empty" role="status">Preparing the weekly report…</p>
  }

  const t = takeaways(r, f)
  const n = sectionNotes(r, f)
  const { x, now: daily, before: dailyBefore } = r.daily

  return (
    <article className="report" data-loading={loading ? '' : undefined} aria-label={`Weekly report, week of ${f.span(r.week)}`}>
      <header className="report__head">
        <p className="report__kicker">Week of {f.span(r.week)}</p>
        <h2 className="report__headline">{t.headline}</h2>
        <p className="report__context">{headlineContext(r, f)}</p>
        {markdown ? <CopyButton text={markdown} /> : null}
      </header>

      <Section title={t.daily}>
        <BarChart
          x={x}
          height={130}
          yTickCount={2}
          series={[{ key: 'now', label: 'This week', color: series(1), values: daily }]}
          ghost={{ label: 'Last week', values: dailyBefore }}
          ghostMark="tick"
          formatValue={(n) => f.money(n)}
          formatTick={(n) => f.money(n).replace(/\.\d+$/, '')}
          formatX={f.day}
        />
        <AxisExtent from={f.day(x[0])} to={f.day(x[x.length - 1])} />
        <p className="report__note">
          <span className="report__key report__key--bar" /> this week
          <span className="report__key report__key--tick" /> last week
        </p>
      </Section>

      <Section title={t.users} note={n.users}>
        <Bars rows={r.topUsers} format={f} empty="No user spend this week." />
      </Section>

      <Section title={t.models} note={n.models}>
        <Bars rows={r.topModels} format={f} empty="No model spend this week." />
      </Section>

      <Section title={t.changes} note={n.changes}>
        <Moves label="By model" rows={topMoves(r.movers.models)} format={f} />
        <Moves label="By user" rows={topMoves(r.movers.users)} format={f} />
      </Section>

      <Section title={t.newAndDropped} note={n.newAndDropped}>
        <Inline label="New models" rows={r.added.models} format={f} />
        <Inline label="New users" rows={r.added.users} format={f} />
        <Inline label="New gateways" rows={r.added.gateways} format={f} name={f.gateway} />
        <Inline label="Models no longer used" rows={r.removed.models} format={f} was />
        <Inline label="Users no longer used" rows={r.removed.users} format={f} was />
        <Inline label="Gateways no longer used" rows={r.removed.gateways} format={f} name={f.gateway} was />
      </Section>

      <Section title={t.providers}>
        {r.providers.length === 0 ? null : (
          <>
            {/* Names and shares are written out beside the bar, so identity
                never rests on colour alone. */}
            <div className="report__split" aria-hidden="true">
              {r.providers.map((p, i) => p.share > 0 ? (
                <span key={p.key} style={{ flexGrow: p.share, background: providerColor(i) }} />
              ) : null)}
            </div>
            <p className="report__legend">
              {r.providers.map((p, i) => (
                <span key={p.key}>
                  <span className="report__swatch" style={{ background: providerColor(i) }} aria-hidden="true" />
                  {p.key} <strong>{f.pct(p.share)}</strong>
                  {p.spend <= 0 && p.before > 0 ? <em> (was {f.money(p.before)})</em> : null}
                </span>
              ))}
            </p>
          </>
        )}
      </Section>

      <footer className="report__foot">
        Monday to Sunday, {zone}.{scopeLabel ? ` Filtered to ${scopeLabel}.` : ''} The Markdown copy has the full lists.
      </footer>
    </article>
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

/** Name, bar of spend scaled to the largest row, amount and share. */
function Bars({ rows, format: f, empty }: { rows: Entry[]; format: ReportFormat; empty: string }) {
  if (rows.length === 0) return <p className="report__none">{empty}</p>
  const max = Math.max(...rows.map((e) => e.spend), 1e-9)
  return (
    <ol className="report__bars">
      {rows.map((e) => (
        <li key={e.key}>
          <span className="report__name" title={e.key}>{e.key}</span>
          <span className="report__track" aria-hidden="true">
            <span className="report__fill" style={{ width: `${Math.max(2, (e.spend / max) * 100)}%` }} />
          </span>
          <span className="report__num">{amount(e.spend, f)}</span>
          <span className="report__share">{f.pct(e.share)}</span>
        </li>
      ))}
    </ol>
  )
}

/** Changes as a diverging bar from a centre line, one colour: increases
 *  right, decreases left, scaled to the largest change in the list. */
function Moves({ label, rows, format: f }: { label: string; rows: Mover[]; format: ReportFormat }) {
  if (rows.length === 0) return null
  const max = Math.max(...rows.map((m) => Math.abs(m.change)), 1e-9)
  return (
    <div className="report__moves">
      <p className="report__label report__movehead">
        <span>{label}</span>
        <span>Change</span>
      </p>
      <ol className="report__bars report__bars--moves">
        {rows.map((m) => (
          <li key={m.key}>
            <span className="report__name" title={moverName(m)}>{moverName(m)}</span>
            <span className="report__diverge" aria-hidden="true">
              <span
                className="report__divbar"
                data-dir={m.change > 0 ? 'up' : 'down'}
                style={{ width: `${Math.max(2, (Math.abs(m.change) / max) * 50)}%` }}
              />
            </span>
            <span className="report__num">{signedMoney(m.change, f.money)}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** "New models: a ($1), b ($2), c ($3) and 4 more" — nothing when empty. */
function Inline({ label, rows, format: f, name = (k) => k, was = false }: {
  label: string; rows: Entry[]; format: ReportFormat; name?: (k: string) => string; was?: boolean
}) {
  if (rows.length === 0) return null
  const shown = rows.slice(0, INLINE)
  const more = rows.length - shown.length
  return (
    <p className="report__inline">
      <span className="report__label">{label}</span>
      {shown.map((e, i) => (
        <span key={e.key}>
          {i > 0 ? ', ' : ''}{name(e.key)} <span className="report__muted">({was ? 'was ' : ''}{amount(e.spend, f)})</span>
        </span>
      ))}
      {more > 0 ? <span className="report__muted"> and {more} more</span> : null}
    </p>
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
