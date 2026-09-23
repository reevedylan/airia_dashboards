import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Calendar, dayLabel } from './Calendar'

export const RANGES = ['24H', '7D', '14D', '1M', '3M'] as const
export type RangeKey = (typeof RANGES)[number]

export interface AnchorControls {
  /** Step the window back or forward by its own length. */
  onStep: (direction: -1 | 1) => void
  /**
   * A custom range, from the calendar. Both ends are civil DAYS, resolved
   * low-to-high whichever order they were clicked; the caller turns them
   * into instants, because only it knows the zone the buckets were aligned
   * to. Choosing one leaves preset mode.
   */
  onSelectRange: (from: string, to: string) => void
  /** Return to the live window of the selected preset. */
  onNow: () => void
  /** True when the window already ends at the wall clock. */
  atNow: boolean
  /** True when the window already reaches the oldest retained data. */
  atOldest?: boolean
  /** The resolved window — shown in BOTH modes, since a custom range has no
   *  "now" to fall back to. */
  resolved?: string
  /** The window on screen, as civil days: banded in the calendar, and named
   *  on the button. */
  window: { from: string; to: string }
  /** Earliest and latest selectable days, and the longest span. */
  maxDay?: string
  minDay?: string
  maxSpanDays?: number
  /** One line under the calendar grid, when no selection is in progress. */
  note?: React.ReactNode
  /** True while a fetch is in flight: the resolved chip then describes the
   *  window still DRAWN rather than the one being fetched, and dims. */
  stale?: boolean
  /** True when the window came from the calendar rather than a preset. */
  custom?: boolean
}

export interface TimeRangeBarProps {
  /** The active preset, or null when a custom range is showing: the two are
   *  mutually exclusive, so nothing is pressed in custom mode. */
  value: RangeKey | null
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

      {/* Shown whenever the window is not the live preset — which includes
          every custom range, since a custom range has no "now" to be at. */}
      {anchor && (!anchor.atNow || anchor.custom) ? (
        <span className="viz-anchor__resolved" data-stale={anchor.stale ? '' : undefined}>
          {anchor.custom ? <span className="viz-anchor__tag">Custom</span> : null}
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
  range, onStep, onSelectRange, atNow, atOldest, window: win, maxDay, minDay, maxSpanDays, note, custom,
}: AnchorControls & { range: RangeKey | null }) {
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
    globalThis.addEventListener('resize', fit)
    return () => globalThis.removeEventListener('resize', fit)
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

  const stepLabel = custom ? 'range' : range

  return (
    <div className="viz-anchor" role="group" aria-label="Window position" ref={root}>
      {/* Stepping past retention would show a window the source has
          already expired. */}
      <button
        type="button"
        className="viz-anchor__step"
        aria-label={`Previous ${stepLabel}`}
        title={atOldest ? 'No data older than this is retained' : `Previous ${stepLabel}`}
        disabled={atOldest}
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
        data-custom={custom ? '' : undefined}
        title="Pick a start and end date"
        onClick={() => setOpen((v) => !v)}
      >
        <CalendarIcon />
        <span className="viz-anchor__daylabel">{spanLabel(win.from, win.to)}</span>
      </button>

      {/* Stepping past now would show a window that has not happened. */}
      <button
        type="button"
        className="viz-anchor__step"
        aria-label={`Next ${stepLabel}`}
        title={atNow ? 'Already at the latest window' : `Next ${stepLabel}`}
        disabled={atNow}
        onClick={() => onStep(1)}
      >
        <ChevronRight />
      </button>

      {open ? (
        <div className="viz-anchor__pop" ref={pop}>
          <Calendar
            label="Choose a start and end date"
            value={win}
            max={maxDay}
            min={minDay}
            maxSpanDays={maxSpanDays}
            note={note}
            onSelect={(from, to) => {
              onSelectRange(from, to)
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

/** "22 Sept 2026", or "4 Mar – 3 Jun 2026" — the year said once. */
function spanLabel(from: string, to: string): string {
  if (from === to) return dayLabel(from)
  const start = from.slice(0, 4) === to.slice(0, 4)
    ? dayLabel(from).replace(/ \d{4}$/, '')
    : dayLabel(from)
  return `${start} – ${dayLabel(to)}`
}

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
