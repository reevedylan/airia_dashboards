import { useMemo, useState } from 'react'
import { full, percent } from '../../lib/format'

export type SortDir = 'asc' | 'desc'

export interface RankColumn {
  /** Matches a key in each row's `cells`. */
  key: string
  heading: string
  format?: (n: number) => string
  /** Recede a derived column so the measured ones lead. */
  muted?: boolean
  /** Allow sorting by this column. */
  sortable?: boolean
}

export interface RankRow {
  key: string
  label: string
  /** Drives the sort order and the inline bar width. */
  value: number
  /** Values for the extra columns, keyed by `RankColumn.key`. */
  cells?: Record<string, number | null | undefined>
  /** Optional leading glyph — a flag, an avatar, an icon. */
  glyph?: string
}

export interface RankTableProps {
  rows: readonly RankRow[]
  labelHeading: string
  valueHeading: string
  /**
   * Makes rows selectable. `selectedKey` marks the active row; clicking it
   * again passes `null`.
   *
   * The proportional bar doubles as the affordance: it is the only thing in
   * the row that looks pressable, and it was previously mistaken for a
   * selection state, so selection is marked distinctly with a ring.
   */
  selectedKey?: string | null
  onSelect?: (key: string | null) => void
  /**
   * Adds a search box. Worth it once the row list is unbounded — a user list
   * grows with the org, unlike a fixed set of models.
   */
  searchable?: boolean
  searchPlaceholder?: string
  /** Allow sorting by the value column and any column marked `sortable`. */
  sortable?: boolean
  /** Extra columns, rendered in order after the value column. */
  columns?: readonly RankColumn[]
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
  rows, labelHeading, valueHeading, columns = [], limit = 6,
  selectedKey = null, onSelect,
  searchable = false, searchPlaceholder = 'Search…', sortable = false,
  formatValue = (n) => full(n),
  barColor = 'var(--viz-seq-200)',
}: RankTableProps) {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  /** `null` column means the value column. */
  const [sort, setSort] = useState<{ col: string | null; dir: SortDir }>({ col: null, dir: 'desc' })

  const { shown, matched, max, total } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q === '' ? rows : rows.filter((r) => r.label.toLowerCase().includes(q))

    const at = (r: RankRow) => (sort.col === null ? r.value : r.cells?.[sort.col])
    const ordered = [...filtered].sort((a, b) => {
      const av = at(a), bv = at(b)
      // Rows with no value for the sorted column sink, whichever direction.
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return sort.dir === 'desc' ? bv - av : av - bv
    })

    return {
      shown: expanded ? ordered : ordered.slice(0, limit),
      matched: ordered.length,
      // The bar is a share of the largest value in the FULL set, so it does
      // not rescale as you search.
      max: Math.max(...rows.map((r) => r.value), 1),
      total: rows.reduce((a, r) => a + r.value, 0),
    }
  }, [rows, expanded, limit, query, sort])

  const head = (key: string | null, heading: string, className?: string, reactKey?: string) => {
    const on = sort.col === key
    if (!sortable) return <th key={reactKey} scope="col" className={className}>{heading}</th>
    return (
      <th key={reactKey} scope="col" className={className} aria-sort={on ? (sort.dir === 'desc' ? 'descending' : 'ascending') : undefined}>
        <button
          type="button"
          onClick={() => setSort((s) => (s.col === key ? { col: key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { col: key, dir: 'desc' }))}
        >
          {heading}
          {on ? <span className="viz-rank__caret" aria-hidden="true">{sort.dir === 'desc' ? '▼' : '▲'}</span> : null}
        </button>
      </th>
    )
  }

  return (
    <div className="viz-rank" data-cols={columns.length || undefined}>
      {searchable ? (
        <div className="viz-rank__tools">
          <input
            className="viz-rank__search"
            type="search"
            value={query}
            placeholder={searchPlaceholder}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="viz-rank__count">
            {matched === rows.length ? `${rows.length} total` : `${matched} of ${rows.length}`}
          </span>
        </div>
      ) : null}
      <table>
        <thead>
          <tr>
            <th scope="col">{labelHeading}</th>
            {head(null, valueHeading, 'viz-rank__num')}
            {columns.map((c) => (
              c.sortable
                ? head(c.key, c.heading, 'viz-rank__num', c.key)
                : <th key={c.key} scope="col" className="viz-rank__num">{c.heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => {
            const selected = selectedKey === row.key
            const cell = (
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
            )
            return (
            <tr
              key={row.key}
              data-selected={selected ? '' : undefined}
              data-selectable={onSelect ? '' : undefined}
              title={`${row.label} — ${formatValue(row.value)} (${percent(row.value / (total || 1))} of total)`}
            >
              <th scope="row">
                {onSelect ? (
                  <button
                    type="button"
                    className="viz-rank__pick"
                    aria-pressed={selected}
                    onClick={() => onSelect(selected ? null : row.key)}
                  >
                    {cell}
                  </button>
                ) : cell}
              </th>
              <td className="viz-rank__num">{formatValue(row.value)}</td>
              {columns.map((c) => {
                const v = row.cells?.[c.key]
                return (
                  <td
                    key={c.key}
                    className={c.muted ? 'viz-rank__num viz-rank__num--muted' : 'viz-rank__num'}
                  >
                    {v == null || !Number.isFinite(v) ? '—' : (c.format ?? full)(v)}
                  </td>
                )
              })}
            </tr>
            )
          })}
        </tbody>
      </table>

      {matched > limit ? (
        <button type="button" className="viz-showall" onClick={() => setExpanded((v) => !v)}>
          <ExpandIcon />
          {expanded ? `Show top ${limit}` : `Show all ${matched}`}
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
