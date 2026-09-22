export const RANGES = ['24H', '7D', '14D', '1M', '3M'] as const
export type RangeKey = (typeof RANGES)[number] | 'Custom'

export interface TimeRangeBarProps {
  value: RangeKey
  onChange: (next: RangeKey) => void
  /** Rendered on the right — filters, saved views, theme toggle. */
  actions?: React.ReactNode
}

/**
 * One filter row, above everything it scopes. Presets first — nobody fights a
 * calendar grid for "last 30 days". Every card below re-renders against the
 * same slice, so the numbers always agree.
 */
export function TimeRangeBar({ value, onChange, actions }: TimeRangeBarProps) {
  return (
    <div className="viz-toolbar">
      <div className="viz-segmented" role="group" aria-label="Time range">
        <button
          type="button"
          className="viz-segmented__btn viz-segmented__btn--custom"
          aria-pressed={value === 'Custom'}
          onClick={() => onChange('Custom')}
        >
          <CalendarIcon />
          Custom
        </button>
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
      {actions ? <div className="viz-toolbar__actions">{actions}</div> : null}
    </div>
  )
}

export function ToolbarButton({ icon, children, onClick }: { icon: React.ReactNode; children: React.ReactNode; onClick?: () => void }) {
  return (
    <button type="button" className="viz-btn" onClick={onClick}>
      {icon}
      {children}
    </button>
  )
}

const CalendarIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
    <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="2" />
    <path d="M2.25 6.5h11.5M5.5 2v2.5M10.5 2v2.5" />
  </svg>
)

export const FilterIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 4h12l-4.6 5.2v3.9L6.6 11.7V9.2z" />
  </svg>
)

export const SavedIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.5" y="2.5" width="8.5" height="8.5" rx="1.8" />
    <path d="M5 13.5h6.2a2.3 2.3 0 0 0 2.3-2.3V5" />
  </svg>
)
