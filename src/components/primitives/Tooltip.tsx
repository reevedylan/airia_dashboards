import type { ReactNode } from 'react'

export interface TooltipRow {
  /** Series colour — drawn as a short line-key, never applied to the text. */
  color: string
  label: string
  value: string
  /** Renders a rect key instead of a line key (bars, areas, arcs). */
  swatch?: 'line' | 'rect'
}

export interface TooltipProps {
  x: number
  y: number
  width: number
  height: number
  title: string
  rows: readonly TooltipRow[]
  footer?: ReactNode
}

const OFFSET = 14
const EST_WIDTH = 244

/**
 * Hover readout. Values lead, labels follow — the reader already knows which
 * series they're on and wants the number.
 *
 * Labels arrive from API responses, so every string goes in as a text node
 * (JSX children), never as innerHTML.
 */
export function Tooltip({ x, y, width, height, title, rows, footer }: TooltipProps) {
  const flipX = x + OFFSET + EST_WIDTH > width
  const left = flipX ? x - OFFSET - EST_WIDTH : x + OFFSET
  const estHeight = 34 + rows.length * 20 + (footer ? 22 : 0)
  const top = Math.max(4, Math.min(y - estHeight / 2, height - estHeight - 4))

  return (
    <div
      className="viz-tooltip"
      role="tooltip"
      style={{ left: Math.max(4, left), top, width: EST_WIDTH }}
    >
      <div className="viz-tooltip__title">{title}</div>
      <div className="viz-tooltip__rows">
        {rows.map((row, i) => (
          <div className="viz-tooltip__row" key={`${row.label}-${i}`}>
            <span
              className={row.swatch === 'rect' ? 'viz-key viz-key--rect' : 'viz-key viz-key--line'}
              style={{ background: row.color }}
              aria-hidden="true"
            />
            <span className="viz-tooltip__label">{row.label}</span>
            <span className="viz-tooltip__value">{row.value}</span>
          </div>
        ))}
      </div>
      {footer ? <div className="viz-tooltip__footer">{footer}</div> : null}
    </div>
  )
}
