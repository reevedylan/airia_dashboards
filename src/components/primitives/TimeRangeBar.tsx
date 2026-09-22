export const RANGES = ['24H', '7D', '14D', '1M', '3M'] as const
export type RangeKey = (typeof RANGES)[number]

export interface TimeRangeBarProps {
  value: RangeKey
  onChange: (next: RangeKey) => void
  /** Rendered on the right — e.g. a theme toggle. */
  actions?: React.ReactNode
}

/**
 * One range row, above everything it scopes. Every card below re-renders
 * against the same range, so the numbers always agree.
 */
export function TimeRangeBar({ value, onChange, actions }: TimeRangeBarProps) {
  return (
    <div className="viz-toolbar">
      <div className="viz-segmented" role="group" aria-label="Time range">
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
