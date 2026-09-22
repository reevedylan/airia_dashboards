import { useState, type ReactNode } from 'react'
import { Legend, type LegendItem } from './Legend'
import { TableView, type TableColumn } from './TableView'

export interface CardProps {
  title: string
  /** The headline figure this card leads with. */
  value?: string
  /** Sub-label under the value, e.g. a unit or comparison. */
  valueSuffix?: string
  /** Extra controls in the header, left of the legend — e.g. a view toggle. */
  controls?: ReactNode
  legend?: readonly LegendItem[]
  activeSeries?: string | null
  onSeriesHover?: (label: string | null) => void
  /** Supplying this adds the table-view toggle. */
  table?: { columns: readonly TableColumn[]; rows: readonly Record<string, string>[] }
  /** Small text under the plot — usually the x-axis extent. */
  footer?: ReactNode
  /** Dim the body while new data loads, holding the previous render. */
  loading?: boolean
  className?: string
  children: ReactNode
}

/**
 * The frame every chart mounts in: title, hero figure, legend, plot, footer,
 * and the table-view toggle. The card grows with its content so the x-axis
 * band is never cropped into a nested scrollbar.
 */
export function Card({
  title, value, valueSuffix, controls, legend, activeSeries, onSeriesHover,
  table, footer, loading, className, children,
}: CardProps) {
  const [showTable, setShowTable] = useState(false)

  return (
    <section className={`viz-card${className ? ` ${className}` : ''}`} aria-label={title}>
      {/*
        Two fixed rows. The title, the view controls and the table button sit
        on row one; series keys get row two of their own.

        They cannot share a row: a legend's width changes with the series on
        show (and wraps entirely at five items), so anything beside it slides
        sideways — and down — whenever the view changes. Splitting them keeps
        the controls still. Row two holds its height even with no legend, so
        switching to a single-series view doesn't shift the plot either.
      */}
      <header className="viz-card__head">
        <div className="viz-card__headline">
          <h2 className="viz-card__title">{title}</h2>
          {controls}
          {table ? (
            <button
              type="button"
              className="viz-iconbtn viz-card__tablebtn"
              aria-pressed={showTable}
              title={showTable ? 'Show chart' : 'Show data table'}
              onClick={() => setShowTable((v) => !v)}
            >
              {showTable ? <ChartIcon /> : <TableIcon />}
              <span className="viz-sr-only">{showTable ? 'Show chart' : 'Show data table'}</span>
            </button>
          ) : null}
        </div>
        {/*
          Rendered whenever the card declares a legend at all — pass an empty
          array for a view that has no keys to show, and the row still holds
          its height. Keying this off `controls` instead made the row appear
          and disappear with a control, resizing the card.
        */}
        {legend ? (
          <div className="viz-card__keys">
            <Legend items={legend} active={activeSeries} onHover={onSeriesHover} />
          </div>
        ) : null}
      </header>

      {value ? (
        <p className="viz-card__value">
          {value}
          {valueSuffix ? <span className="viz-card__value-suffix"> {valueSuffix}</span> : null}
        </p>
      ) : null}

      <div className="viz-card__body" data-loading={loading ? '' : undefined}>
        {showTable && table
          ? <TableView caption={`${title} — data table`} columns={table.columns} rows={table.rows} />
          : children}
      </div>

      {footer && !showTable ? <footer className="viz-card__foot">{footer}</footer> : null}
    </section>
  )
}

/** Start and end of the plotted range, sat under the plot. */
export function AxisExtent({ from, to }: { from: string; to: string }) {
  return (
    <div className="viz-extent">
      <span>{from}</span>
      <span>{to}</span>
    </div>
  )
}

const TableIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M2 6.5h12M6.5 6.5V13" />
  </svg>
)

const ChartIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 13h12M4 10.5l3-3.5 2.5 2.2L13.5 4" />
  </svg>
)
