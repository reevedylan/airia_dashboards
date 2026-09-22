import { useMemo, useState } from 'react'
import { full, percent } from '../../lib/format'

export interface RankRow {
  key: string
  label: string
  /** Drives both the sort order and the inline bar width. */
  value: number
  /** Optional second measure, shown as its own column. */
  secondary?: number
  /** Optional third measure — usually something derived from the first two. */
  tertiary?: number
  /** Optional leading glyph — a flag, an avatar, an icon. */
  glyph?: string
}

export interface RankTableProps {
  rows: readonly RankRow[]
  /** Column headings. */
  labelHeading: string
  valueHeading: string
  /** Supplying a heading turns the matching row field into a column. */
  secondaryHeading?: string
  tertiaryHeading?: string
  formatSecondary?: (n: number) => string
  formatTertiary?: (n: number) => string
  /** Rows shown before the "Show all" control appears. */
  limit?: number
  formatValue?: (n: number) => string
  /** Single hue for the inline bars — magnitude, so one hue, not a rainbow. */
  barColor?: string
}

/**
 * A ranked list where the row itself is the chart: each label sits on a bar
 * whose width is its share of the largest value.
 *
 * This replaces the usual decorative per-row colour chip. A different hue per
 * row would encode nothing (the categories are nominal and already ordered by
 * the number beside them); a proportional bar in one hue encodes the magnitude
 * the reader came for.
 */
export function RankTable({
  rows, labelHeading, valueHeading, limit = 6,
  secondaryHeading, tertiaryHeading,
  formatValue = (n) => full(n),
  formatSecondary = (n) => full(n),
  formatTertiary = (n) => full(n),
  barColor = 'var(--viz-seq-200)',
}: RankTableProps) {
  const [expanded, setExpanded] = useState(false)

  const { shown, max, total } = useMemo(() => {
    const sorted = [...rows].sort((a, b) => b.value - a.value)
    return {
      shown: expanded ? sorted : sorted.slice(0, limit),
      max: Math.max(...sorted.map((r) => r.value), 1),
      total: sorted.reduce((a, r) => a + r.value, 0),
    }
  }, [rows, expanded, limit])

  return (
    <div className="viz-rank">
      <table>
        <thead>
          <tr>
            <th scope="col">{labelHeading}</th>
            <th scope="col" className="viz-rank__num">{valueHeading}</th>
            {secondaryHeading ? <th scope="col" className="viz-rank__num">{secondaryHeading}</th> : null}
            {tertiaryHeading ? <th scope="col" className="viz-rank__num">{tertiaryHeading}</th> : null}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.key} title={`${row.label} — ${formatValue(row.value)} (${percent(row.value / (total || 1))} of total)`}>
              <th scope="row">
                <span className="viz-rank__cell">
                  <span
                    className="viz-rank__bar"
                    style={{ width: `${Math.max(6, (row.value / max) * 100)}%`, background: barColor }}
                    aria-hidden="true"
                  />
                  <span className="viz-rank__text">
                    {row.glyph ? <span className="viz-rank__glyph" aria-hidden="true">{row.glyph}</span> : null}
                    {row.label}
                  </span>
                </span>
              </th>
              <td className="viz-rank__num">{formatValue(row.value)}</td>
              {secondaryHeading ? (
                <td className="viz-rank__num">{row.secondary == null ? '—' : formatSecondary(row.secondary)}</td>
              ) : null}
              {tertiaryHeading ? (
                <td className="viz-rank__num viz-rank__num--muted">
                  {row.tertiary == null ? '—' : formatTertiary(row.tertiary)}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>

      {rows.length > limit ? (
        <button type="button" className="viz-showall" onClick={() => setExpanded((v) => !v)}>
          <ExpandIcon />
          {expanded ? 'Show less' : `Show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  )
}

const ExpandIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 2.5H2.5V6M10 13.5h3.5V10M13.5 6V2.5H10M2.5 10v3.5H6" />
  </svg>
)
