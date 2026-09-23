import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Calendar, dayLabel } from './Calendar'

export const RANGES = ['24H', '7D', '14D', '1M', '3M'] as const
export type RangeKey = (typeof RANGES)[number]

export interface AnchorControls {
  /** Step the window back or forward by its own length. */
  onStep: (direction: -1 | 1) => void
  /**
   * Jump to the window of the selected duration ending on this day.
   *
   * A DAY, not an instant: the window then ends on a boundary every bucket
   * size divides, so the bars land on the same grid whatever the range. The
   * caller turns the civil day into an instant, because only it knows the
   * zone the buckets were aligned to.
   */
  onPickDay: (day: string) => void
  /** Return to the live, ending-now window. */
  onNow: () => void
  /** True when the window already ends at the wall clock. */
  atNow: boolean
  /** The resolved window, shown only when it is not the live one. */
  resolved?: string
  /**
   * True while a fetch is in flight. The chip describes the window that is
   * DRAWN, so during a load it belongs to the held render rather than to the
   * date beside it, and is dimmed to say so.
   */
  stale?: boolean
  /** The day the window ends on, `YYYY-MM-DD` in the data's zone. */
  day: string
  /** The day the window starts on — banded in the calendar. */
  fromDay?: string
  /** Latest selectable day: today, in the data's zone. */
  maxDay?: string
  /** Earliest day the source still holds. */
  minDay?: string
  /** One line under the calendar grid: what a click will actually select. */
  note?: React.ReactNode
}

export interface TimeRangeBarProps {
  value: RangeKey
  onChange: (next: RangeKey) => void
  /** Moves the window in time without changing its duration. */
  anchor?: AnchorControls
  /** Scope controls, beside the range tabs — they belong together because
   *  both narrow the same data for everything below. */
  filters?: React.ReactNode
  /** Rendered on the right — e.g. a theme toggle. */
  actions?: React.ReactNode
}

/**
 * One range row, above everything it scopes. Every card below re-renders
 * against the same range, so the numbers always agree.
 *
 * Duration and anchor are separate controls. The buttons pick how long a
 * window is; the chevrons and the calendar pick where it ends. Folding both
 * into one control is what makes most range pickers awkward — and a
 * two-ended date picker would make the bucket size depend on how wide a span
 * you happened to drag.
 */
export function TimeRangeBar({ value, onChange, anchor, filters, actions }: TimeRangeBarProps) {
  return (
    <div className="viz-toolbar">
      <div className="viz-segmented" role="group" aria-label="Window duration">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            className="viz-segmented__btn"
            aria-pressed={value === r}
            onClick={() => onChange(r)}
          >
            {r}
          </button>
        ))}
      </div>

      {anchor ? <AnchorBar range={value} {...anchor} /> : null}

      {anchor && !anchor.atNow ? (
        <span className="viz-anchor__resolved" data-stale={anchor.stale ? '' : undefined}>
          {anchor.resolved}
          <button type="button" onClick={anchor.onNow}>Jump to now</button>
        </span>
      ) : null}

      {filters}
      {actions ? <div className="viz-toolbar__actions">{actions}</div> : null}
    </div>
  )
}

/**
 * Chevron, date, chevron — sized to match the duration control beside it, so
 * the pair reads as one row of controls rather than two unrelated widgets.
 */
function AnchorBar({
  range, onStep, onPickDay, atNow, day, fromDay, maxDay, minDay, note,
}: AnchorControls & { range: RangeKey }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  /* Keep the popover inside the viewport. It hangs off the left edge of a
     control that is itself near the right edge on a narrow screen, where it
     would otherwise push the whole page sideways. Measured rather than
     guessed with a media query: what overflows depends on where the toolbar
     wrapped, not on the breakpoint. */
  useLayoutEffect(() => {
    if (!open) return
    const fit = () => {
      const el = pop.current
      if (!el) return
      el.style.transform = ''
      const r = el.getBoundingClientRect()
      const over = r.right - (document.documentElement.clientWidth - GUTTER)
      if (over > 0) el.style.transform = `translateX(${-Math.min(over, r.left - GUTTER)}px)`
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [open])

  // Close on outside click or Escape, and hand focus back to the trigger —
  // a popover that swallows focus is worse than no popover.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="viz-anchor" role="group" aria-label="Window position" ref={root}>
      <button
        type="button"
        className="viz-anchor__step"
        aria-label={`Previous ${range}`}
        title={`Previous ${range}`}
        onClick={() => onStep(-1)}
      >
        <ChevronLeft />
      </button>

      <button
        ref={trigger}
        type="button"
        className="viz-anchor__date"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`The ${range} window ending on this day`}
        onClick={() => setOpen((v) => !v)}
      >
        <CalendarIcon />
        <span className="viz-anchor__daylabel">{dayLabel(day)}</span>
      </button>

      {/* Stepping past now would show a window that has not happened. */}
      <button
        type="button"
        className="viz-anchor__step"
        aria-label={`Next ${range}`}
        title={atNow ? 'Already at the latest window' : `Next ${range}`}
        disabled={atNow}
        onClick={() => onStep(1)}
      >
        <ChevronRight />
      </button>

      {open ? (
        <div className="viz-anchor__pop" ref={pop}>
          <Calendar
            label={`End date for the ${range} window`}
            value={day}
            from={fromDay}
            max={maxDay}
            min={minDay}
            note={note}
            onPick={(d) => {
              onPickDay(d)
              setOpen(false)
              trigger.current?.focus()
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

/** Breathing room kept between the popover and the window edge. */
const GUTTER = 8

export interface ToolbarButtonProps {
  icon: React.ReactNode
  children: React.ReactNode
  onClick?: () => void
  /** `sm` fits inside a card's headline row without changing its height. */
  size?: 'md' | 'sm'
}

const ChevronLeft = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 3.5L5.5 8l4.5 4.5" />
  </svg>
)

const ChevronRight = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 3.5L10.5 8 6 12.5" />
  </svg>
)

const CalendarIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
    <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="2" />
    <path d="M2.25 6.5h11.5M5.5 2v2.5M10.5 2v2.5" />
  </svg>
)

export function ToolbarButton({ icon, children, onClick, size = 'md' }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={size === 'sm' ? 'viz-btn viz-btn--sm' : 'viz-btn'}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  )
}
