/**
 * The weekly report: one completed Monday–Sunday week against the one
 * before it.
 *
 * Pure, like the rest of the fold. Both weeks arrive as FULL fact-table
 * windows (`ranges.report` and `ranges.reportPrev`) rather than as a window
 * plus comparison totals, because "new this week" and "not used this week"
 * need to know which models, users and gateways the earlier week had — not
 * just what it cost. Everything here is `breakdown()` on each week, under
 * the same scopes, compared.
 *
 * It describes the week that happened and nothing else: no forecast, no
 * estimated savings. Changes are reported neutrally — more spend is not
 * inherently good or bad — so the wording says "up" and "down", never
 * "worse" or "better".
 */

import { SERVICE_KEY, type RangeBlock } from '../lib/airia/aggregate'
import { breakdown, delta, seriesFor, type Dimension, type Scope } from './fold'
import type { DayRange } from './window'

export interface Entry {
  key: string
  spend: number
  /** Share of the week's spend, 0–1. */
  share: number
}

/** A top-three row: this week's spend, and last week's for its change. */
export interface Ranked extends Entry {
  before: number
}

export interface Mover {
  key: string
  now: number
  before: number
  change: number
  /** Absent last week: the whole change is an arrival. */
  isNew: boolean
  /** Absent this week: the whole change is a departure. */
  isGone: boolean
}

export interface Totals {
  spend: number
  tokens: number
  executions: number
}

export interface WeeklyReport {
  week: DayRange
  previous: DayRange
  now: Totals
  before: Totals
  /** With last week's spend, for each row's change. */
  topUsers: Ranked[]
  topModels: Ranked[]
  movers: {
    users: { up: Mover[]; down: Mover[] }
    models: { up: Mover[]; down: Mover[] }
  }
  /** Present this week, absent last week — with this week's spend. */
  added: Record<'models' | 'users' | 'gateways', Entry[]>
  /** Present last week, absent this week — with LAST week's spend. */
  removed: Record<'models' | 'users' | 'gateways', Entry[]>
  /** Share of spend held by the top three users, or null with no spend. */
  top3UsersShare: number | null
  userCount: number
  modelCount: number
  /** Calls made with the tenant's standard key, not an individual's, are
   *  among this week's "users" — worth saying, since it is not a person. */
  serviceKeyUsed: boolean
  /** How many users / models moved the SAME way as the week's total —
   *  for "rose $X, spread across N models". */
  movedWith: { users: number; models: number }
  providers: Array<Entry & { before: number }>
  /** Spend per day, Monday first, for this week and the week before. */
  daily: { x: number[]; now: number[]; before: number[] }
}

/** How many entries the top and mover lists carry. */
const TOP = 3
/** A change smaller than a cent is rounding, not movement. */
const MIN_CHANGE = 0.005

const totals = (rows: ReturnType<typeof breakdown>): Totals => ({
  spend: rows.reduce((a, r) => a + r.spend, 0),
  tokens: rows.reduce((a, r) => a + r.tokens, 0),
  executions: rows.reduce((a, r) => a + r.executions, 0),
})

export function buildReport(
  cur: RangeBlock,
  prev: RangeBlock,
  scope: Scope,
  week: DayRange,
  previous: DayRange,
): WeeklyReport {
  const both = (dim: Dimension) => ({ now: breakdown(cur, dim, scope), before: breakdown(prev, dim, scope) })
  const users = both('user')
  const models = both('model')
  const gateways = both('gateway')
  const providers = both('provider')

  // Any dimension sums to the same totals; the user axis is as good as any.
  const now = totals(users.now)
  const before = totals(users.before)

  const entry = (total: number) => (r: { key: string; spend: number }): Entry =>
    ({ key: r.key, spend: r.spend, share: total > 0 ? r.spend / total : 0 })
  const ranked = ({ now: a, before: b }: ReturnType<typeof both>): Ranked[] => {
    const was = new Map(b.map((r) => [r.key, r.spend]))
    return a.slice(0, TOP).map((r) => ({ ...entry(now.spend)(r), before: was.get(r.key) ?? 0 }))
  }

  const movers = ({ now: a, before: b }: ReturnType<typeof both>) => {
    const was = new Map(b.map((r) => [r.key, r.spend]))
    const is = new Map(a.map((r) => [r.key, r.spend]))
    const all: Mover[] = [...new Set([...is.keys(), ...was.keys()])].map((key) => {
      const n = is.get(key) ?? 0
      const p = was.get(key) ?? 0
      return { key, now: n, before: p, change: n - p, isNew: !was.has(key), isGone: !is.has(key) }
    })
    return {
      up: all.filter((m) => m.change >= MIN_CHANGE).sort((x, y) => y.change - x.change).slice(0, TOP),
      down: all.filter((m) => m.change <= -MIN_CHANGE).sort((x, y) => x.change - y.change).slice(0, TOP),
    }
  }

  /** In `a`, not in `b`, largest spend first. `total` is `a`'s week. */
  const only = (a: ReturnType<typeof breakdown>, b: ReturnType<typeof breakdown>, total: number): Entry[] => {
    const other = new Set(b.map((r) => r.key))
    return a.filter((r) => !other.has(r.key)).map(entry(total))
  }

  const top3 = users.now.slice(0, TOP).reduce((a, r) => a + r.spend, 0)
  const net = now.spend - before.spend
  const movedWith = (x: ReturnType<typeof both>) => {
    const was = new Map(x.before.map((r) => [r.key, r.spend]))
    const is = new Map(x.now.map((r) => [r.key, r.spend]))
    return [...new Set([...is.keys(), ...was.keys()])]
      .filter((k) => { const c = (is.get(k) ?? 0) - (was.get(k) ?? 0); return Math.abs(c) >= MIN_CHANGE && Math.sign(c) === Math.sign(net) })
      .length
  }
  /* Every provider in EITHER week. One used last week and not this one
     still belongs in the split, at $0 — dropping it made last week's column
     sum short of last week's total. */
  const wasByProvider = new Map(providers.before.map((r) => [r.key, r.spend]))
  const isByProvider = new Map(providers.now.map((r) => [r.key, r.spend]))
  const providerRows = [...new Set([...isByProvider.keys(), ...wasByProvider.keys()])]
    .map((key) => ({ key, spend: isByProvider.get(key) ?? 0, before: wasByProvider.get(key) ?? 0 }))
    .sort((x, y) => y.spend - x.spend || y.before - x.before)

  return {
    week,
    previous,
    now,
    before,
    topUsers: ranked(users),
    topModels: ranked(models),
    movers: { users: movers(users), models: movers(models) },
    added: {
      models: only(models.now, models.before, now.spend),
      users: only(users.now, users.before, now.spend),
      gateways: only(gateways.now, gateways.before, now.spend),
    },
    removed: {
      models: only(models.before, models.now, before.spend),
      users: only(users.before, users.now, before.spend),
      gateways: only(gateways.before, gateways.now, before.spend),
    },
    top3UsersShare: now.spend > 0 ? top3 / now.spend : null,
    userCount: users.now.length,
    serviceKeyUsed: users.now.some((u) => u.key === SERVICE_KEY),
    modelCount: models.now.length,
    movedWith: { users: movedWith(users), models: movedWith(models) },
    providers: providerRows.map((r) => ({ ...entry(now.spend)(r), before: r.before })),
    // Both weeks are folded at a daily grain, so index i is the same
    // weekday in each — Monday against Monday.
    daily: { x: cur.x, now: seriesFor(cur, scope).paid, before: seriesFor(prev, scope).paid },
  }
}

/* ------------------------------------------------------------ wording -- */

export interface ReportFormat {
  money: (n: number) => string
  /** A day's bucket start as "Tue 22 Sept", in the report's zone. */
  day: (t: number) => string
  /** The same instant as "Tuesday". */
  weekday: (t: number) => string
  /** Whole counts, grouped: "3,319". */
  count: (n: number) => string
  /** Token counts, abbreviated as the dashboard shows them: "616.3M". */
  tokens: (n: number) => string
  pct: (fraction: number) => string
  /** "21 Sept – 27 Sept 2026". */
  span: (w: DayRange) => string
  /** Display text for a gateway id. */
  gateway: (id: string) => string
}

/** "+$210.40", "−$12.00", "$0.00". A true minus sign, not a hyphen. */
export const signedMoney = (n: number, money: (n: number) => string): string =>
  n > 0 ? `+${money(n)}` : n < 0 ? `−${money(-n)}` : money(0)

/** "+$210.40 (20.5%)", "+$4.00 (new)", or "no change". */
export function changeText(now: number, before: number, f: ReportFormat): string {
  const d = delta(now, before)
  if (!d || d.direction === 'none') return 'no change'
  const pct = d.text === 'new' ? 'new' : `${d.direction === 'up' ? '+' : '−'}${d.text}`
  return `${signedMoney(now - before, f.money)} (${pct})`
}

/* ---------------------------------------------------------- takeaways -- */

/**
 * The thresholds the takeaway headings turn on, in one place.
 *
 * Each heading is a fixed template chosen by rule — no model writes them —
 * so the same week always reads the same way and every heading can be
 * checked against the rows beneath it.
 */
const RULES = {
  /** Below this change either way, spend is "flat". */
  flat: 0.02,
  /** One day at or above this share of the week is the story. */
  peakDay: 0.4,
  /** No day above this share, and the week was "spread evenly". */
  evenDay: 0.25,
  /** One user or model at or above this share "drove" spend. */
  dominant: 0.5,
  /** One mover explaining at least this much of the change leads. */
  explains: 0.5,
  /** One provider at or above this "carried" spend. */
  provider: 0.9,
} as const

export interface Takeaways {
  headline: string
  daily: string
  users: string
  models: string
  changes: string
  newAndDropped: string
  providers: string
}

const pct0 = (x: number) => `${Math.round(x * 100)}%`
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
/** A user as a heading may name them: never a person, only the service key. */
const who = (key: string, one = '1 user') => (key === SERVICE_KEY ? 'Standard key' : one)

/**
 * One heading per section, stating what happened.
 *
 * Rules in priority order, first match wins; percentages rather than words
 * like "two-thirds", which would sometimes round the wrong way; neutral
 * verbs — "drove", "was", "accounts for" — and never a judgement. A person
 * is never named in a heading; the rows beneath do that.
 */
export function takeaways(r: WeeklyReport, f: ReportFormat): Takeaways {
  const spend = r.now.spend
  const net = spend - r.before.spend
  const change = r.before.spend > 0 ? net / r.before.spend : null
  const d = delta(spend, r.before.spend)

  const headline = spend <= 0 && r.before.spend <= 0 ? 'No spend this week'
    : r.before.spend <= 0 ? `${f.money(spend)} spent, up from nothing`
    : spend <= 0 ? `No spend this week, down from ${f.money(r.before.spend)}`
    : change != null && Math.abs(change) < RULES.flat ? `Spend flat at ${f.money(spend)}`
    : `Spend ${d!.direction} ${d!.text} to ${f.money(spend)}`

  const days = r.daily.now
  const peak = days.reduce((best, v, i) => (v > days[best] ? i : best), 0)
  const peakShare = spend > 0 ? days[peak] / spend : 0
  const daily = spend <= 0 ? 'Nothing spent on any day'
    : peakShare >= RULES.peakDay ? `${f.weekday(r.daily.x[peak])} was ${pct0(peakShare)} of the week`
    : peakShare <= RULES.evenDay ? 'Spend spread evenly across the week'
    : `Busiest day: ${f.weekday(r.daily.x[peak])}, ${f.money(days[peak])}`

  /* Each says OUT OF how many — "spread across 23 users" was read as "only
     23 people used it" — but no more than that. The whole report is one
     week, so no heading restates which. */
  const u = r.topUsers[0]
  const users = !u ? 'No user spend this week'
    : r.userCount === 1 ? (u.key === SERVICE_KEY ? 'All spend on the standard key' : 'All spend from 1 user')
    : u.share >= RULES.dominant
      ? (u.key === SERVICE_KEY ? `Standard key drove ${pct0(u.share)} of spend` : `1 of ${r.userCount} users drove ${pct0(u.share)} of spend`)
    : r.userCount > TOP ? `Top ${TOP} of ${r.userCount} users drove ${pct0(r.top3UsersShare ?? 0)} of spend`
    : `Spend split across ${r.userCount} users`

  const m = r.topModels[0]
  const top3Models = r.topModels.reduce((a, e) => a + e.share, 0)
  const models = !m ? 'No model spend this week'
    : r.modelCount === 1 ? `${m.key} was the only model`
    : m.share >= RULES.dominant ? `${m.key} was ${pct0(m.share)} of spend (${r.modelCount} models used)`
    : r.modelCount > TOP ? `Top ${TOP} of ${r.modelCount} models were ${pct0(top3Models)} of spend`
    : `Spend split across ${r.modelCount} models`

  // The single mover that best explains the week's net change, if any.
  const lead = (list: Mover[]) => list.find((x) => Math.sign(x.change) === Math.sign(net))
  const candidates = [
    { m: lead(net >= 0 ? r.movers.models.up : r.movers.models.down), user: false },
    { m: lead(net >= 0 ? r.movers.users.up : r.movers.users.down), user: true },
  ].filter((c): c is { m: Mover; user: boolean } => c.m != null)
  const best = candidates.find((c) => net !== 0 && c.m.change / net >= RULES.explains)
  const name = (c: { m: Mover; user: boolean }) => (c.user ? who(c.m.key) : c.m.key)
  /* Says what changed — "81% of the decrease" left a reader asking:
     decrease of what? — and nothing more. The amounts are in the rows. */
  const riseOrFall = net >= 0 ? 'rise' : 'fall'
  const changes = spend <= 0 && r.before.spend <= 0 ? 'No spend either week'
    : change != null && Math.abs(change) < RULES.flat ? 'Token spend barely changed'
    : best && best.m.change / net > 1 ? `${name(best)} ${net > 0 ? 'rose' : 'fell'} more than total spend did`
    : best ? `${name(best)} drove ${pct0(best.m.change / net)} of the ${riseOrFall} in token spend`
    : `Token spend ${net >= 0 ? 'rose' : 'fell'} ${f.money(Math.abs(net))}` +
      (r.movedWith.models > 1 ? ` across ${r.movedWith.models} models` : '')

  /* "No longer used" rather than "dropped", which could mean anything. */
  const added = [
    r.added.models.length ? plural(r.added.models.length, 'new model') : null,
    r.added.users.length ? plural(r.added.users.length, 'new user') : null,
    r.added.gateways.length ? plural(r.added.gateways.length, 'new gateway') : null,
  ].filter(Boolean) as string[]
  const removed = [
    r.removed.models.length ? plural(r.removed.models.length, 'model') : null,
    r.removed.users.length ? plural(r.removed.users.length, 'user') : null,
    r.removed.gateways.length ? plural(r.removed.gateways.length, 'gateway') : null,
  ].filter(Boolean) as string[]
  const newAndDropped = added.length === 0 && removed.length === 0
    ? 'Same models, users and gateways as last week'
    : [added.length ? added.join(', ') : null, removed.length ? `${removed.join(', ')} no longer used` : null]
        .filter(Boolean).join(' · ')

  const p = r.providers[0]
  const active = r.providers.filter((x) => x.spend > 0).length
  const providers = !p || spend <= 0 ? 'No provider spend this week'
    : p.share >= RULES.provider ? `${p.key} carried ${f.pct(p.share)} of spend`
    : `Spend split across ${plural(active, 'provider')}`

  return { headline, daily, users, models, changes, newAndDropped, providers }
}

/** The line under a heading that says what counts — so "23 users" is never
 *  read as "only 23 people used it". Short, and never a date: the whole
 *  report is one week. Empty means no note. */
export interface SectionNotes {
  users: string
  models: string
  changes: string
  newAndDropped: string
}

export function sectionNotes(r: WeeklyReport, f: ReportFormat): SectionNotes {
  return {
    users: 'Anyone with at least one gateway call.' + (r.serviceKeyUsed ? ' The service key counts as one.' : ''),
    models: '',
    changes: `Total: ${f.money(r.before.spend)} → ${f.money(r.now.spend)}.`,
    newAndDropped: 'New: not used last week. No longer used: used last week, not this week.',
  }
}

/** An amount, without rounding a real but tiny cost to "$0.00". */
export const amount = (n: number, f: ReportFormat): string =>
  n > 0 && n < 0.005 ? `<${f.money(0.01)}` : f.money(n)

/** The subline under the headline: last week, and the other two measures. */
export const headlineContext = (r: WeeklyReport, f: ReportFormat): string =>
  `vs ${f.money(r.before.spend)} last week · ${f.tokens(r.now.tokens)} tokens · ${f.count(r.now.executions)} executions`

/**
 * The biggest changes in one dimension, largest first whichever way —
 * what a short "what changed" list should show.
 */
export const topMoves = (m: { up: Mover[]; down: Mover[] }, n = TOP): Mover[] =>
  [...m.up, ...m.down].sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, n)

/* ----------------------------------------------------------- markdown -- */

/** Table cells cannot contain a bare pipe or a line break. */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

function table(head: string[], align: ('l' | 'r')[], rows: string[][]): string {
  const sep = align.map((a) => (a === 'r' ? '---:' : '---'))
  return [head, sep, ...rows].map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n')
}

/**
 * The report as Markdown, for pasting into Slack, an email or a ticket.
 *
 * The same order and the same takeaway headings as the page, so reading
 * just the headings is the summary. Lists the page shortens to "and N
 * more" are complete here, for the reader who wants the detail.
 */
export function reportMarkdown(
  r: WeeklyReport,
  f: ReportFormat,
  { zone, scopeLabel }: { zone: string; scopeLabel: string | null },
): string {
  const t = takeaways(r, f)
  const n = sectionNotes(r, f)
  const out: string[] = []
  out.push(`## Gateway spend: week of ${f.span(r.week)}`)
  out.push(`**${t.headline}**  \n${headlineContext(r, f)}`)
  out.push(`*Monday to Sunday, ${zone}.*` + (scopeLabel ? ` *Filtered to ${scopeLabel}.*` : ''))

  out.push(`### ${t.daily}`)
  out.push(table(['Day', 'This week', 'Last week'], ['l', 'r', 'r'],
    r.daily.x.map((x, i) => [f.day(x), f.money(r.daily.now[i]), f.money(r.daily.before[i] ?? 0)])))

  const entries = (label: string, rows: Entry[]) =>
    rows.length === 0 ? '_No spend this week._'
      : table([label, 'Spend', 'Share'], ['l', 'r', 'r'], rows.map((e) => [e.key, amount(e.spend, f), f.pct(e.share)]))
  out.push(`### ${t.users}`)
  out.push(`*${n.users}*`)
  out.push(entries('User', r.topUsers))
  out.push(`### ${t.models}`)
  if (n.models) out.push(`*${n.models}*`)
  out.push(entries('Model', r.topModels))

  out.push(`### ${t.changes}`)
  out.push(`*${n.changes}*`)
  const moves = (label: string, m: { up: Mover[]; down: Mover[] }) => {
    const rows = [...m.up, ...m.down]
    return rows.length === 0 ? `_${label}: no change of a cent or more._`
      : table([label, 'This week', 'Last week', 'Change'], ['l', 'r', 'r', 'r'],
          rows.map((x) => [moverName(x), f.money(x.now), f.money(x.before), signedMoney(x.change, f.money)]))
  }
  out.push(moves('Model', r.movers.models))
  out.push(moves('User', r.movers.users))

  out.push(`### ${t.newAndDropped}`)
  out.push(`*${n.newAndDropped}*`)
  const list = (rows: Entry[], name: (k: string) => string, was = false) =>
    rows.map((e) => `${name(e.key)} (${was ? 'was ' : ''}${amount(e.spend, f)})`).join(', ')
  const lines = [
    ['New models', r.added.models, (k: string) => k, false],
    ['New users', r.added.users, (k: string) => k, false],
    ['New gateways', r.added.gateways, f.gateway, false],
    ['Models no longer used', r.removed.models, (k: string) => k, true],
    ['Users no longer used', r.removed.users, (k: string) => k, true],
    ['Gateways no longer used', r.removed.gateways, f.gateway, true],
  ] as const
  const present = lines.filter(([, rows]) => rows.length > 0)
  if (present.length) {
    out.push(present.map(([label, rows, name, was]) => `- **${label}:** ${list(rows, name, was)}`).join('\n'))
  }

  out.push(`### ${t.providers}`)
  out.push(r.providers.length === 0 ? '_No spend this week._'
    : table(['Provider', 'Spend', 'Share', 'Change'], ['l', 'r', 'r', 'r'],
        r.providers.map((p) => [p.key, f.money(p.spend), f.pct(p.share), changeText(p.spend, p.before, f)])))

  return out.join('\n\n') + '\n'
}

/** A mover's name, marked when the whole change is an arrival or departure. */
export const moverName = (m: Mover): string => m.isNew ? `${m.key} (new)` : m.isGone ? `${m.key} (no longer used)` : m.key
