import { useMemo, useState } from 'react'
import { Calendar } from './Calendar'
import { CalendarDays, Check, Search, X } from './icons'
import { addDays, dayDate, spanDays, type Day } from '../../lib/day'

/**
 * The time picker, laid out the way Grafana's is: quick ranges on the right,
 * an absolute From/To on the left, and a calendar that slides out beside it
 * on demand.
 *
 * Two things differ from Grafana, on purpose:
 *
 * - **Whole days only.** A field takes `YYYY-MM-DD`, `now` or `now-Nd` —
 *   never a time of day. A window shorter than a day is what the 24-hour
 *   range is for, and buckets are aligned to local midnight; a custom range
 *   starting at 14:37 would have a ragged first bar.
 * - **A quick range typed by hand IS the quick range.** `now-7d` to `now`
 *   selects "Last 7 days" — the live, moving window — rather than a fixed
 *   custom span that happens to cover the same days today. Otherwise the
 *   same question would have two answers that drift apart by tomorrow.
 */

export interface QuickRange<K extends string> {
  key: K
  label: string
  /** The From expression it is equivalent to, with To = `now`. */
  from: string
}

export interface TimePickerProps<K extends string> {
  quick: readonly QuickRange<K>[]
  /** The active quick range, or null when an absolute range is showing. */
  value: K | null
  /** The absolute range showing, as civil days, when `value` is null. */
  custom: { from: Day; to: Day } | null
  onQuick: (key: K) => void
  /** Both ends resolved low-to-high; the caller turns days into instants. */
  onApply: (from: Day, to: Day) => void
  /** Most recent first. */
  recent: readonly { from: Day; to: Day }[]
  /** Today and the oldest retained day, in the data's zone. */
  today: Day
  minDay: Day
  maxSpanDays: number
  /** e.g. "Australia/Sydney" and "UTC+10:00". */
  zone: string
  offset: string
}

type Parsed = { day: Day } | { error: string }

export function TimePicker<K extends string>({
  quick, value, custom, onQuick, onApply, recent, today, minDay, maxSpanDays, zone, offset,
}: TimePickerProps<K>) {
  const initial = value != null
    ? { from: quick.find((q) => q.key === value)?.from ?? 'now-7d', to: 'now' }
    : custom ?? { from: 'now-7d', to: 'now' }
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [calendar, setCalendar] = useState(false)
  const [search, setSearch] = useState('')
  /** Errors show once a field has been left or Apply pressed, not mid-typing. */
  const [touched, setTouched] = useState(false)

  const parse = (text: string): Parsed => parseDay(text, { today, minDay })
  const pf = parse(from)
  const pt = parse(to)
  /** A typed quick range, e.g. `now-30d` → `now`. */
  const quickMatch = to.trim().toLowerCase() === 'now'
    ? quick.find((q) => q.from === from.trim().toLowerCase()) ?? null
    : null
  const rangeError = quickMatch || 'error' in pf || 'error' in pt ? null
    : pf.day > pt.day ? 'From is after To.'
    : spanDays(pf.day, pt.day) > maxSpanDays ? `At most ${maxSpanDays} days at once.`
    : null
  const ok = quickMatch != null || (!('error' in pf) && !('error' in pt) && rangeError == null)

  const apply = () => {
    setTouched(true)
    if (!ok) return
    if (quickMatch) onQuick(quickMatch.key)
    else if ('day' in pf && 'day' in pt) onApply(pf.day, pt.day)
  }

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q === '' ? quick : quick.filter((r) => r.label.toLowerCase().includes(q))
  }, [quick, search])

  // What to band in the calendar: the fields if they parse, else the window.
  const band = 'day' in pf && 'day' in pt && pf.day <= pt.day ? { from: pf.day, to: pt.day } : custom

  return (
    <div className="viz-tp" role="dialog" aria-label="Time range">
      {calendar ? (
        <div className="viz-tp__cal">
          <div className="viz-tp__calhead">
            <span>Select a time range</span>
            <button type="button" className="viz-tp__x" aria-label="Close calendar" onClick={() => setCalendar(false)}>
              <X size={13} />
            </button>
          </div>
          <Calendar
            label="Choose a start and end date"
            value={band}
            min={minDay}
            max={today}
            maxSpanDays={maxSpanDays}
            note="Click a start day, then an end day."
            onSelect={(a, b) => { setFrom(a); setTo(b); setTouched(true); setCalendar(false) }}
          />
        </div>
      ) : null}

      <div className="viz-tp__main">
        <div className="viz-tp__panes">
          <section className="viz-tp__abs" aria-label="Absolute time range">
            <h3 className="viz-tp__title">Absolute time range</h3>
            <Field
              label="From" value={from} onChange={setFrom} onBlur={() => setTouched(true)}
              error={touched && !quickMatch && 'error' in pf ? pf.error : null}
              onCalendar={() => setCalendar((v) => !v)} calendarOpen={calendar} onEnter={apply}
            />
            <Field
              label="To" value={to} onChange={setTo} onBlur={() => setTouched(true)}
              error={touched && !quickMatch && 'error' in pt ? pt.error : null}
              onCalendar={() => setCalendar((v) => !v)} calendarOpen={calendar} onEnter={apply}
            />
            {touched && rangeError ? <p className="viz-tp__error" role="alert">{rangeError}</p> : null}
            <button type="button" className="viz-tp__apply" disabled={touched && !ok} onClick={apply}>
              Apply time range
            </button>

            {recent.length > 0 ? (
              <>
                <h3 className="viz-tp__title viz-tp__title--sub">Recently used absolute ranges</h3>
                <ul className="viz-tp__recent">
                  {recent.map((r) => (
                    <li key={`${r.from}|${r.to}`}>
                      <button type="button" className="viz-tp__range" onClick={() => onApply(r.from, r.to)}>
                        {r.from === r.to ? r.from : `${r.from} to ${r.to}`}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>

          <section className="viz-tp__quick" aria-label="Quick ranges">
            <label className="viz-tp__search">
              <Search size={14} />
              <input
                type="search"
                value={search}
                placeholder="Search quick ranges"
                aria-label="Search quick ranges"
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div role="listbox" aria-label="Quick ranges">
              {shown.length === 0 ? <p className="viz-tp__empty">No matches</p> : shown.map((q) => (
                <button
                  key={q.key}
                  type="button"
                  role="option"
                  aria-selected={q.key === value}
                  className="viz-tp__range viz-tp__quickitem"
                  onClick={() => onQuick(q.key)}
                >
                  {q.label}
                  {q.key === value ? <Check className="viz-menu__check" size={14} /> : null}
                </button>
              ))}
            </div>
          </section>
        </div>

        <footer className="viz-tp__foot">
          <span><strong>Time zone</strong> {zone}</span>
          <span className="viz-tp__offset">{offset}</span>
        </footer>
      </div>
    </div>
  )
}

function Field({
  label, value, onChange, onBlur, error, onCalendar, calendarOpen, onEnter,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onBlur: () => void
  error: string | null
  onCalendar: () => void
  calendarOpen: boolean
  onEnter: () => void
}) {
  return (
    <div className="viz-tp__field">
      <label className="viz-tp__label">
        {label}
        <span className="viz-tp__input" data-error={error ? '' : undefined}>
          <input
            value={value}
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            onKeyDown={(e) => { if (e.key === 'Enter') onEnter() }}
          />
          <button
            type="button"
            className="viz-tp__calbtn"
            aria-label="Open calendar"
            aria-pressed={calendarOpen}
            onClick={onCalendar}
          >
            <CalendarDays size={15} />
          </button>
        </span>
      </label>
      {error ? <p className="viz-tp__error">{error}</p> : null}
    </div>
  )
}

/**
 * `YYYY-MM-DD`, `now`, or `now-Nd`, resolved to a civil day.
 *
 * `now-Nd` is the day N days before today, so `now-10d` to `now` is eleven
 * days — both ends are whole days, and both are included.
 */
export function parseDay(text: string, { today, minDay }: { today: Day; minDay: Day }): Parsed {
  const t = text.trim().toLowerCase()
  let day: Day | null = null
  if (t === 'now') day = today
  else {
    const rel = /^now-(\d{1,3})d$/.exec(t)
    if (rel) day = addDays(today, -Number(rel[1]))
    else if (/^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(dayDate(t).getTime())
      && dayDate(t).toISOString().slice(0, 10) === t) day = t
  }
  if (day == null) return { error: 'Use YYYY-MM-DD, now, or now-7d.' }
  if (day > today) return { error: 'That day has not happened yet.' }
  if (day < minDay) return { error: `Older than the retained history, which starts ${minDay}.` }
  return { day }
}



