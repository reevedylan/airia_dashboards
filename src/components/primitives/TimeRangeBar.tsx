export const RANGES = ['24H', '7D', '14D', '1M', '3M'] as const
export type RangeKey = (typeof RANGES)[number]

export interface AnchorControls {
  /** Step the window back or forward by its own length. */
  onStep: (direction: -1 | 1) => void
  /** Jump to the window of the selected duration ending on this date. */
  onPickDate: (isoDate: string) => void
  /** Return to the live, ending-now window. */
  onNow: () => void
  /** True when the window already ends at the wall clock. */
  atNow: boolean
  /** The resolved window, shown only when it is not the live one. */
  resolved?: string
  /** Pre-fills the date input; the anchor's own day. */
  dateValue?: string
  /** Latest selectable day. */
  maxDate?: string
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
 */
/**
 * Duration and anchor are separate controls. The buttons pick how long a
 * window is; the chevrons and date picker pick where it ends. Folding both
 * into one control is what makes most range pickers awkward.
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
      {anchor ? (
        <div className="viz-anchor" role="group" aria-label="Window position">
          <button
            type="button"
            className="viz-anchor__step"
            aria-label={`Previous ${value}`}
            title={`Previous ${value}`}
            onClick={() => anchor.onStep(-1)}
          >
            <ChevronLeft />
          </button>

          <label className="viz-anchor__date" title="Jump to a date">
            <CalendarIcon />
            <input
              type="date"
              value={anchor.dateValue ?? ''}
              max={anchor.maxDate}
              aria-label={`End date for the ${value} window`}
              onChange={(e) => e.target.value && anchor.onPickDate(e.target.value)}
            />
          </label>

          {/* Stepping past now would show a window that has not happened. */}
          <button
            type="button"
            className="viz-anchor__step"
            aria-label={`Next ${value}`}
            title={anchor.atNow ? 'Already at the latest window' : `Next ${value}`}
            disabled={anchor.atNow}
            onClick={() => anchor.onStep(1)}
          >
            <ChevronRight />
          </button>
        </div>
      ) : null}

      {anchor && !anchor.atNow ? (
        <span className="viz-anchor__resolved">
          {anchor.resolved}
          <button type="button" onClick={anchor.onNow}>Jump to now</button>
        </span>
      ) : null}

      {filters}
      {actions ? <div className="viz-toolbar__actions">{actions}</div> : null}
    </div>
  )
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
