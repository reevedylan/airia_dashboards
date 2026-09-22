export interface LegendItem {
  label: string
  color: string
  /** Mirror the mark: a line for line series, a rect for bars/areas/arcs. */
  shape?: 'line' | 'dot' | 'rect'
}

export interface LegendProps {
  items: readonly LegendItem[]
  /** Dim the series that aren't hovered, to isolate one. */
  active?: string | null
  onHover?: (label: string | null) => void
}

/**
 * Always present for two or more series — identity must never rest on colour
 * alone. A single-series chart renders nothing here: the card title already
 * names what's plotted, and a one-swatch box just restates it.
 */
export function Legend({ items, active, onHover }: LegendProps) {
  if (items.length < 2) return null
  return (
    <ul className="viz-legend">
      {items.map((item) => (
        <li key={item.label}>
          <button
            type="button"
            className="viz-legend__item"
            data-dim={active != null && active !== item.label ? '' : undefined}
            onPointerEnter={() => onHover?.(item.label)}
            onPointerLeave={() => onHover?.(null)}
            onFocus={() => onHover?.(item.label)}
            onBlur={() => onHover?.(null)}
          >
            <span
              className={`viz-key viz-key--${item.shape ?? 'dot'}`}
              style={{ background: item.color }}
              aria-hidden="true"
            />
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  )
}
