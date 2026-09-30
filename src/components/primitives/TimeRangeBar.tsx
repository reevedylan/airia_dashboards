import { dayLabel } from './Calendar'
import { DropTrigger, SelectMenu, type SelectMenuOption } from './Dropdown'
import { TimePicker, type QuickRange } from './TimePicker'
import { ChevronLeft, ChevronRight } from './icons'
import { usePopover } from './popover'
import type { Day } from '../../lib/day'

export const RANGES = ['24H', '7D', '14D', '30D', '90D'] as const
export type RangeKey = (typeof RANGES)[number]

/** What each preset is called in the picker and on its trigger. */
export const RANGE_LABELS: Record<RangeKey, string> = {
  '24H': 'Last 24 hours',
  '7D': 'Last 7 days',
  '14D': 'Last 14 days',
  '30D': 'Last 30 days',
  '90D': 'Last 90 days',
}

/** The duration alone — for a window that no longer ends now, and for
 *  "vs previous 7 days". */
export const RANGE_SPANS: Record<RangeKey, string> = {
  '24H': '24 hours',
  '7D': '7 days',
  '14D': '14 days',
  '30D': '30 days',
  '90D': '90 days',
}

const QUICK: readonly QuickRange<RangeKey>[] = RANGES.map((r) => ({
  key: r,
  label: RANGE_LABELS[r],
  from: r === '24H' ? 'now-24h' : `now-${r.slice(0, -1)}d`,
}))

export interface AnchorControls {
  /** Step the window back or forward by its own length. */
  onStep: (direction: -1 | 1) => void
  /** True when the window already ends at the wall clock. */
  atNow: boolean
  /** True when the window already reaches the oldest retained data. */
  atOldest?: boolean
  /** The window on screen, as civil days, named on the pager. */
  window: { from: string; to: string }
  /** True when the window came from the picker's absolute range. */
  custom?: boolean
}

export interface PickerControls {
  /** An absolute range: both ends are civil days, resolved low-to-high.
   *  The caller turns them into instants — only it knows the zone. */
  onApply: (from: Day, to: Day) => void
  recent: readonly { from: Day; to: Day }[]
  today: Day
  minDay: Day
  maxSpanDays: number
  zone: string
  offset: string
}

export interface GrainControls {
  value: number
  options: readonly SelectMenuOption<number>[]
  onChange: (next: number) => void
}

export interface TimeRangeBarProps {
  /** The active preset, or null when a custom range is showing: the two are
   *  mutually exclusive. */
  value: RangeKey | null
  onChange: (next: RangeKey) => void
  anchor: AnchorControls
  picker: PickerControls
  grain?: GrainControls
  /** Scope controls, first in the row: they narrow the data for everything
   *  below, before the window says which part of it. */
  filters?: React.ReactNode
  /** Rendered on the right — e.g. a theme toggle. */
  actions?: React.ReactNode
}

/** Every label the time trigger can show, so its width never changes. */
const TIME_SIZERS = [...Object.values(RANGE_LABELS), ...Object.values(RANGE_SPANS), 'Custom range']

/**
 * The toolbar: scope, window, grain, and where the window sits.
 *
 *   All users ∨   All gateways ∨   Last 7 days ∨   2-hourly ∨   ‹ 24 – 30 Sept 2026 ›
 *
 * Read left to right it is a sentence about what is on screen. Each part is
 * text and a chevron until you reach for it.
 *
 * Two zones, not one wrapping row: the controls wrap among THEMSELVES and
 * the actions keep the right edge, so what changes on the left cannot push
 * what is on the right onto a line of its own. And nothing in the controls
 * comes and goes, or changes width, when the window moves — the time
 * trigger reserves its widest label, the pager its widest date, and the
 * pager is present even on the live window.
 */
export function TimeRangeBar({ value, onChange, anchor, picker, grain, filters, actions }: TimeRangeBarProps) {
  const p = usePopover()
  const live = anchor.atNow && !anchor.custom
  const label = anchor.custom || value == null ? 'Custom range'
    : live ? RANGE_LABELS[value]
    : RANGE_SPANS[value]
  const span = spanLabel(anchor.window.from, anchor.window.to)

  return (
    <div className="viz-toolbar">
      <div className="viz-toolbar__controls">
        {filters}

        <div className="viz-dropwrap viz-time" ref={p.root}>
          <DropTrigger
            ref={p.trigger}
            className="viz-time__trigger"
            label={label}
            sizers={TIME_SIZERS}
            open={p.open}
            active={!live}
            title={span}
            ariaLabel={`Time range: ${label}, ${span}`}
            onClick={() => p.setOpen((v) => !v)}
          />
          {p.open ? (
            <div className="viz-time__pop" ref={p.pop}>
              <TimePicker
                quick={QUICK}
                value={anchor.custom ? null : value}
                custom={anchor.custom ? anchor.window : null}
                onQuick={(k) => { onChange(k); p.close() }}
                onApply={(a, b) => { picker.onApply(a, b); p.close() }}
                recent={picker.recent}
                today={picker.today}
                minDay={picker.minDay}
                maxSpanDays={picker.maxSpanDays}
                zone={picker.zone}
                offset={picker.offset}
              />
            </div>
          ) : null}
        </div>

        {grain ? (
          <SelectMenu
            className="viz-grain__trigger"
            heading="Granularity"
            value={grain.value}
            options={grain.options}
            onChange={grain.onChange}
          />
        ) : null}

        <Pager {...anchor} live={live} range={value} span={span} />
      </div>
      {actions ? <div className="viz-toolbar__actions">{actions}</div> : null}
    </div>
  )
}

/**
 * Previous window, the dates on screen, next window.
 *
 * Present on the live window too, where it says which days "Last 7 days"
 * covers — so stepping back changes a label, never the layout.
 */
function Pager({
  onStep, atNow, atOldest, window: win, custom, live, range, span,
}: AnchorControls & { live: boolean; range: RangeKey | null; span: string }) {
  const unit = custom || range == null ? 'range' : RANGE_SPANS[range]
  return (
    <div className="viz-pager" role="group" aria-label="Window position" data-past={live ? undefined : ''}>
      {/* Stepping past retention would show a window the source has
          already expired. */}
      <button
        type="button"
        className="viz-anchor__step"
        aria-label={`Previous ${unit}`}
        title={atOldest ? 'No data older than this is retained' : `Previous ${unit}`}
        disabled={atOldest}
        onClick={() => onStep(-1)}
      >
        <ChevronLeft size={16} />
      </button>
      {/* Invisible copies of the widest labels of the same shape share the
          cell, so "Sept" being wider than "Mar" cannot nudge anything. */}
      <span className="viz-pager__label">
        <span>{span}</span>
        {widestLabels(win.from, win.to).map((s) => (
          <span key={s} className="viz-drop__sizer" aria-hidden="true">{s}</span>
        ))}
      </span>
      {/* Stepping past now would show a window that has not happened. */}
      <button
        type="button"
        className="viz-anchor__step"
        aria-label={`Next ${unit}`}
        title={atNow ? 'Already at the latest window' : `Next ${unit}`}
        disabled={atNow}
        onClick={() => onStep(1)}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  )
}

const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'))

/** The same label shape — single day, one year, across years — in every
    month. Digits are tabular, so only the month names change the width. */
function widestLabels(from: string, to: string): string[] {
  const y0 = from.slice(0, 4), y1 = to.slice(0, 4)
  return MONTHS.map((m) => spanLabel(`${y0}-${m}-${from === to ? '28' : '27'}`, `${y1}-${m}-28`))
}

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


