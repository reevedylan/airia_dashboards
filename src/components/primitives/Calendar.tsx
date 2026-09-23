import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * A month-view calendar that speaks CIVIL DAYS, never instants.
 *
 * Every value in and out is an ISO `YYYY-MM-DD` string, and every bit of
 * arithmetic below runs on UTC dates — which is exact, because a civil
 * calendar is the same in every zone: September has 30 days in Sydney and in
 * Reykjavik, and the 22nd is a Tuesday in both.
 *
 * Turning a chosen day into an instant is the caller's job, and has to be:
 * only the caller knows which zone the data's buckets were aligned to, and
 * "the end of the 22nd" is a different moment in each one.
 */
export interface CalendarProps {
  /** The selected day. */
  value: string
  /** Latest selectable day — later days render disabled. */
  max?: string
  /** Earliest selectable day. */
  min?: string
  /**
   * First day of the window this selection resolves to. Days from here to
   * `value` are banded, so the duration the range buttons chose is visible
   * while you pick where it ends.
   */
  from?: string
  /** Today, for the "today" marker and the shortcut. Defaults to `max`. */
  today?: string
  onPick: (day: string) => void
  /** Standing text under the grid — what a click will actually select. */
  note?: React.ReactNode
  /** Accessible name for the dialog. */
  label?: string
}

/* --------------------------------------------------------- civil dates -- */

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
/** UTC midnight of a civil day — a handle for arithmetic, not an instant. */
const at = (day: string) => new Date(`${day}T00:00:00Z`)
const shift = (day: string, days: number) => {
  const d = at(day)
  d.setUTCDate(d.getUTCDate() + days)
  return iso(d)
}
const monthOf = (day: string) => day.slice(0, 7)
const shiftMonth = (day: string, months: number) => {
  const d = at(day)
  const target = d.getUTCMonth() + months
  // Clamp rather than roll over: 31 Mar back a month is 28 Feb, not 3 Mar.
  const last = new Date(Date.UTC(d.getUTCFullYear(), target + 1, 0)).getUTCDate()
  return iso(new Date(Date.UTC(d.getUTCFullYear(), target, Math.min(d.getUTCDate(), last))))
}

/** Six weeks from the Monday on or before the 1st — a grid that never reflows. */
function grid(month: string): string[] {
  const first = `${month}-01`
  const dow = (at(first).getUTCDay() + 6) % 7          // Monday = 0
  const start = shift(first, -dow)
  return Array.from({ length: 42 }, (_, i) => shift(start, i))
}

/* Dates are formatted in UTC because the strings above ARE civil dates: any
   other zone would shift them by a day at the edges. */
const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts })
const MONTH_YEAR = fmt({ month: 'long', year: 'numeric' })
const FULL_DAY = fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const WEEKDAYS = (() => {
  const narrow = fmt({ weekday: 'short' })
  // 2024-01-01 was a Monday; the week starts there to match en-GB/en-AU.
  return Array.from({ length: 7 }, (_, i) => narrow.format(at(shift('2024-01-01', i))))
})()

/** "22 Sept 2026" — the same civil day the calendar deals in. */
export const dayLabel = (day: string, style: 'short' | 'long' = 'short'): string =>
  (style === 'long' ? FULL_DAY : fmt({ day: 'numeric', month: 'short', year: 'numeric' })).format(at(day))

/* ------------------------------------------------------------ calendar -- */

export function Calendar({ value, max, min, from, today = max, onPick, note, label = 'Choose a date' }: CalendarProps) {
  const [month, setMonth] = useState(() => monthOf(value))
  /** Roving focus. Keyboard moves this; a click just picks. */
  const [cursor, setCursor] = useState(value)
  const gridRef = useRef<HTMLDivElement>(null)
  const moved = useRef(false)

  // Follow the selection when it changes underneath us (stepping the window
  // with the popover open), but never fight the keyboard mid-navigation.
  useEffect(() => { setCursor(value); setMonth(monthOf(value)) }, [value])

  const days = useMemo(() => grid(month), [month])
  const blocked = (day: string) => (max != null && day > max) || (min != null && day < min)

  // Only steal focus once the keyboard has been used, so opening the popover
  // with the mouse does not yank focus off the trigger.
  useEffect(() => {
    if (!moved.current) return
    gridRef.current?.querySelector<HTMLButtonElement>('[data-cursor]')?.focus()
  }, [cursor])

  const move = (days: number) => {
    const next = shift(cursor, days)
    if (blocked(next)) return
    moved.current = true
    setCursor(next)
    setMonth(monthOf(next))
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    if (e.key in step) { e.preventDefault(); move(step[e.key]); return }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault()
      const next = shiftMonth(cursor, e.key === 'PageUp' ? -1 : 1)
      if (!blocked(next)) { moved.current = true; setCursor(next); setMonth(monthOf(next)) }
    }
  }

  const stepMonth = (by: number) => setMonth(monthOf(shiftMonth(`${month}-01`, by)))
  // A month is reachable if any day in it is: its last day is on or after
  // `min`, its first on or before `max`.
  const prevBlocked = min != null && shift(`${month}-01`, -1) < min
  const nextBlocked = max != null && `${monthOf(shiftMonth(`${month}-01`, 1))}-01` > max

  return (
    <div className="viz-cal" role="dialog" aria-label={label}>
      <div className="viz-cal__head">
        <button
          type="button" className="viz-cal__nav" disabled={prevBlocked}
          aria-label="Previous month" onClick={() => stepMonth(-1)}
        >
          <Chevron dir="left" />
        </button>
        <span className="viz-cal__month" aria-live="polite">{MONTH_YEAR.format(at(`${month}-01`))}</span>
        <button
          type="button" className="viz-cal__nav" disabled={nextBlocked}
          aria-label="Next month" onClick={() => stepMonth(1)}
        >
          <Chevron dir="right" />
        </button>
      </div>

      <div className="viz-cal__dow" aria-hidden="true">
        {WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}
      </div>

      {/* A plain group of buttons, not role="grid": a grid without real rows
          reads worse to a screen reader than no grid at all, and every day
          already carries its full date as its label. */}
      <div className="viz-cal__grid" ref={gridRef} role="group" onKeyDown={onKeyDown}>
        {days.map((day) => {
          const out = monthOf(day) !== month
          const off = blocked(day)
          // The band shows the window the range buttons chose, so it is
          // obvious that a click moves a fixed duration rather than an edge.
          const inWindow = from != null && day >= from && day <= value
          return (
            <button
              key={day}
              type="button"
              className="viz-cal__day"
              disabled={off}
              tabIndex={day === cursor ? 0 : -1}
              data-cursor={day === cursor ? '' : undefined}
              data-outside={out ? '' : undefined}
              data-today={day === today ? '' : undefined}
              data-window={inWindow ? '' : undefined}
              data-selected={day === value ? '' : undefined}
              aria-pressed={day === value}
              aria-label={dayLabel(day, 'long')}
              onClick={() => { setCursor(day); onPick(day) }}
            >
              {at(day).getUTCDate()}
            </button>
          )
        })}
      </div>

      <div className="viz-cal__foot">
        {note ? <p className="viz-cal__note">{note}</p> : null}
        {today ? (
          <button
            type="button" className="viz-cal__todaybtn"
            disabled={value === today} onClick={() => onPick(today)}
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
