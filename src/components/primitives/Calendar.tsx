import { useEffect, useMemo, useRef, useState } from 'react'
import { addDays, addMonths, dayDate, monthOf, spanDays, type Day } from '../../lib/day'

/**
 * A month-view calendar that picks a RANGE of civil days.
 *
 * Days, never instants: everything in and out is `YYYY-MM-DD`, and the
 * arithmetic behind it is UTC-based, which is exact rather than approximate
 * because a civil calendar is the same in every zone — September has 30
 * days in Sydney and in Reykjavik, and the 22nd is a Tuesday in both.
 *
 * Turning a day into a moment is the caller's job, and has to be: only the
 * caller knows which zone the data's buckets were aligned to, and "the end
 * of the 22nd" is a different instant in each one.
 *
 * There is deliberately no time of day. A window shorter than a day is what
 * the 24H preset is for, and two controls answering the same question is
 * how a picker becomes a puzzle.
 */
export interface CalendarProps {
  /** The window currently on screen, banded for context. */
  value: { from: Day; to: Day } | null
  /** Earliest and latest selectable days. */
  min?: Day
  max?: Day
  /** Longest selectable span, counted inclusively. */
  maxSpanDays?: number
  /** Today, for the marker and the "this month" shortcut. Defaults to `max`. */
  today?: Day
  /** Both ends, resolved low-to-high whichever order they were clicked. */
  onSelect: (from: Day, to: Day) => void
  /** Standing text under the grid, shown when no selection is in progress. */
  note?: React.ReactNode
  label?: string
}

/* Formatted in UTC because these strings ARE civil dates: any other zone
   would shift them by a day at the edges. */
const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts })
const MONTH_YEAR = fmt({ month: 'long', year: 'numeric' })
const FULL_DAY = fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const SHORT_DAY = fmt({ day: 'numeric', month: 'short', year: 'numeric' })
const WEEKDAYS = (() => {
  const short = fmt({ weekday: 'short' })
  // 2024-01-01 was a Monday; the week starts there to match en-GB/en-AU.
  return Array.from({ length: 7 }, (_, i) => short.format(dayDate(addDays('2024-01-01', i))))
})()

/** "22 Sept 2026" — the same civil day the calendar deals in. */
export const dayLabel = (day: Day, style: 'short' | 'long' = 'short'): string =>
  (style === 'long' ? FULL_DAY : SHORT_DAY).format(dayDate(day))

/** Six weeks from the Monday on or before the 1st — a grid that never reflows. */
function grid(month: string): Day[] {
  const first = `${month}-01`
  const dow = (dayDate(first).getUTCDay() + 6) % 7          // Monday = 0
  return Array.from({ length: 42 }, (_, i) => addDays(first, i - dow))
}

const lo = (a: Day, b: Day) => (a <= b ? a : b)
const hi = (a: Day, b: Day) => (a <= b ? b : a)

export function Calendar({
  value, min, max, maxSpanDays = 365, today = max, onSelect, note, label = 'Choose a date range',
}: CalendarProps) {
  /** The first click of a two-click selection. Null between selections. */
  const [pending, setPending] = useState<Day | null>(null)
  const [preview, setPreview] = useState<Day | null>(null)
  const [month, setMonth] = useState(() => monthOf(value?.to ?? today ?? '2026-01-01'))
  const [cursor, setCursor] = useState<Day>(value?.to ?? today ?? '2026-01-01')
  const gridRef = useRef<HTMLDivElement>(null)
  const moved = useRef(false)

  // Follow the window when it changes underneath us — stepping it with the
  // popover open — but never mid-selection, which would move the anchor
  // someone is currently measuring from.
  useEffect(() => {
    if (pending || !value) return
    setCursor(value.to)
    setMonth(monthOf(value.to))
  }, [value?.from, value?.to]) // eslint-disable-line react-hooks/exhaustive-deps

  const days = useMemo(() => grid(month), [month])

  /**
   * A day is unpickable if it is outside the source's retention, in the
   * future, or — once a start is down — further from it than a whole year.
   * Disabling rather than validating on submit: an invalid range should
   * never be expressible, so there is nothing to reject.
   */
  const blocked = (day: Day) =>
    (min != null && day < min) ||
    (max != null && day > max) ||
    (pending != null && spanDays(pending, day) > maxSpanDays)

  // Only steal focus once the keyboard has been used, so opening with the
  // mouse does not yank focus off the trigger.
  useEffect(() => {
    if (!moved.current) return
    gridRef.current?.querySelector<HTMLButtonElement>('[data-cursor]')?.focus()
  }, [cursor])

  const move = (by: number) => {
    const next = addDays(cursor, by)
    if (blocked(next)) return
    moved.current = true
    setCursor(next)
    setMonth(monthOf(next))
    if (pending) setPreview(next)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    if (e.key in step) { e.preventDefault(); move(step[e.key]); return }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault()
      const next = addMonths(cursor, e.key === 'PageUp' ? -1 : 1)
      if (!blocked(next)) { moved.current = true; setCursor(next); setMonth(monthOf(next)); if (pending) setPreview(next) }
    }
  }

  /** First click arms the range; second completes it and applies at once. */
  const pick = (day: Day) => {
    setCursor(day)
    if (pending == null) { setPending(day); setPreview(day); return }
    setPending(null)
    setPreview(null)
    onSelect(lo(pending, day), hi(pending, day))
  }

  // What to band: the selection being drawn, or the window on screen.
  const band = pending != null
    ? { from: lo(pending, preview ?? pending), to: hi(pending, preview ?? pending) }
    : value

  const stepMonth = (by: number) => setMonth(monthOf(addMonths(`${month}-01`, by)))
  const prevBlocked = min != null && addDays(`${month}-01`, -1) < min
  const nextBlocked = max != null && `${monthOf(addMonths(`${month}-01`, 1))}-01` > max

  return (
    <div className="viz-cal" role="dialog" aria-label={label}>
      <div className="viz-cal__head">
        <button type="button" className="viz-cal__nav" disabled={prevBlocked} aria-label="Previous month" onClick={() => stepMonth(-1)}>
          <Chevron dir="left" />
        </button>
        <span className="viz-cal__month" aria-live="polite">{MONTH_YEAR.format(dayDate(`${month}-01`))}</span>
        <button type="button" className="viz-cal__nav" disabled={nextBlocked} aria-label="Next month" onClick={() => stepMonth(1)}>
          <Chevron dir="right" />
        </button>
      </div>

      <div className="viz-cal__dow" aria-hidden="true">
        {WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}
      </div>

      {/* A plain group of buttons, not role="grid": a grid without real rows
          reads worse to a screen reader than no grid at all, and every day
          already carries its full date as its label. */}
      <div
        className="viz-cal__grid"
        ref={gridRef}
        role="group"
        onKeyDown={onKeyDown}
        onPointerLeave={() => { if (pending) setPreview(pending) }}
      >
        {days.map((day) => {
          const off = blocked(day)
          const inBand = band != null && day >= band.from && day <= band.to
          const edge = !inBand || band == null ? undefined
            : band.from === band.to ? 'only'
            : day === band.from ? 'start'
            : day === band.to ? 'end'
            : undefined
          return (
            <button
              key={day}
              type="button"
              className="viz-cal__day"
              disabled={off}
              tabIndex={day === cursor ? 0 : -1}
              data-cursor={day === cursor ? '' : undefined}
              data-outside={monthOf(day) !== month ? '' : undefined}
              data-today={day === today ? '' : undefined}
              data-window={inBand ? '' : undefined}
              data-edge={edge}
              data-pending={pending === day ? '' : undefined}
              aria-pressed={inBand}
              aria-label={dayLabel(day, 'long')}
              onClick={() => pick(day)}
              onPointerEnter={() => { if (pending) setPreview(day) }}
            >
              {dayDate(day).getUTCDate()}
            </button>
          )
        })}
      </div>

      <div className="viz-cal__foot">
        <p className="viz-cal__note">
          {pending != null
            ? <>From <strong>{dayLabel(pending)}</strong> — now pick the end day. Up to {maxSpanDays} days; the same day again is a single day.</>
            : note}
        </p>
        {today ? (
          <button
            type="button" className="viz-cal__todaybtn"
            disabled={monthOf(today) === month}
            aria-label="Go to this month"
            onClick={() => setMonth(monthOf(today))}
          >
            Today
          </button>
        ) : null}
      </div>
    </div>
  )
}

const Chevron = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={dir === 'left' ? 'M10 3.5L5.5 8l4.5 4.5' : 'M6 3.5L10.5 8 6 12.5'} />
  </svg>
)
