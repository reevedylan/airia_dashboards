import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from '../primitives/icons'
import { Tooltip } from '../primitives/Tooltip'
import { full, share, signedPercent } from '../../lib/format'

/** One line of the hover readout. */
export interface RankDetail {
  label: string
  value: string
}

export interface RankRow {
  key: string
  label: string
  /** Drives the order, the bar and the figure beside it. */
  value: number
  /**
   * Change against the comparison period, as a fraction (0.6 is +60%).
   * `'new'` when the row had nothing there. `null` when there
   * is no comparison to make, which shows a dash rather than a guess.
   */
  change?: number | 'new' | null
  /** Everything else about the row, shown on hover rather than in columns. */
  detail?: readonly RankDetail[]
  /** Optional leading glyph — a flag, an avatar, an icon. */
  glyph?: string
}

export interface RankTableProps {
  rows: readonly RankRow[]
  labelHeading: string
  valueHeading: string
  changeHeading?: string
  /** What the change is measured against, e.g. "vs previous 7 days" —
   *  the change heading's tooltip. */
  changeNote?: string
  /** The badge for a row that had nothing in the comparison period. */
  newLabel?: string
  /**
   * Makes rows selectable. `selectedKey` marks the active row; clicking it
   * again passes `null`. Selection is a ring on the row, deliberately unlike
   * the proportional bar, which encodes magnitude and was once read as a
   * selected state.
   */
  selectedKey?: string | null
  onSelect?: (key: string | null) => void
  /** Rows per page. */
  pageSize?: number
  formatValue?: (n: number) => string
  /** Single hue for the bars — magnitude, so one hue, not a rainbow. */
  barColor?: string
  /** Small print under the hover readout, e.g. what a click does. */
  detailFooter?: string
}

/** Below this a change is reported as no change, not "+0.0%". */
const FLAT = 0.0005

/**
 * A ranked list in the shape of Google Trends' query tables: rank, name, a
 * short bar for magnitude, the figure, and its change against the period
 * before. Everything else about a row is in the hover readout, so the list
 * answers "what, how much, and which way" and stops there.
 *
 * Changes are neutral — an arrow and a signed percentage, never red or
 * green. More spend is not inherently good or bad.
 */
export function RankTable({
  rows, labelHeading, valueHeading, changeHeading = 'Change', changeNote,
  newLabel = 'New',
  selectedKey = null, onSelect, pageSize = 10,
  formatValue = (n) => full(n),
  barColor = 'var(--viz-seq-400)',
  detailFooter,
}: RankTableProps) {
  const [page, setPage] = useState(0)
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)

  const ordered = [...rows].sort((a, b) => b.value - a.value)
  const pages = Math.max(1, Math.ceil(ordered.length / pageSize))
  // Clamped rather than reset: a range change can shorten the list under a
  // later page, and landing on the last one beats landing on nothing.
  const at = Math.min(page, pages - 1)
  const shown = ordered.slice(at * pageSize, (at + 1) * pageSize)
  // A share of the WHOLE, not of the largest row: scaled to the largest,
  // the top row always filled its track and read as 100% of spend. Over the
  // full set, so bars do not rescale from page to page.
  const total = rows.reduce((a, r) => a + r.value, 0)
  const shareOf = (v: number) => (total > 0 ? v / total : 0)

  /** The readout follows the pointer, or sits beside a row reached by keyboard. */
  const place = (key: string, clientX: number, clientY: number) => {
    const r = box.current?.getBoundingClientRect()
    if (r) setHover({ key, x: clientX - r.left, y: clientY - r.top })
  }
  const hovered = hover ? ordered.find((r) => r.key === hover.key) : undefined

  return (
    <div className="viz-rank" ref={box} onMouseLeave={() => setHover(null)}>
      <table>
        <thead>
          <tr>
            <th scope="col" className="viz-rank__pos"><span className="viz-sr-only">Rank</span></th>
            <th scope="col">{labelHeading}</th>
            <th scope="col" className="viz-rank__barcol">Share of total</th>
            <th scope="col" className="viz-rank__num">{valueHeading}</th>
            <th scope="col" className="viz-rank__change" title={changeNote}>{changeHeading}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => {
            const selected = selectedKey === row.key
            const label = (
              <span className="viz-rank__text">
                {row.glyph ? <span className="viz-rank__glyph" aria-hidden="true">{row.glyph}</span> : null}
                {row.label}
              </span>
            )
            return (
              <tr
                key={row.key}
                data-selected={selected ? '' : undefined}
                data-selectable={onSelect ? '' : undefined}
                onMouseMove={(e) => place(row.key, e.clientX, e.clientY)}
                // The whole row picks, not just the name: the bar and the
                // figures are where the eye is when deciding to click. The
                // name's button still gives keyboard access, and its click
                // bubbles here, so there is exactly one handler.
                onClick={onSelect ? () => onSelect(selected ? null : row.key) : undefined}
              >
                <td className="viz-rank__pos">{at * pageSize + i + 1}</td>
                <th scope="row">
                  {onSelect ? (
                    <button
                      type="button"
                      className="viz-rank__pick"
                      aria-pressed={selected}
                      onFocus={(e) => {
                        const r = e.currentTarget.getBoundingClientRect()
                        place(row.key, r.right, r.top + r.height / 2)
                      }}
                      onBlur={() => setHover(null)}
                    >
                      {label}
                    </button>
                  ) : label}
                </th>
                <td className="viz-rank__barcol">
                  <span className="viz-rank__share">
                    <span className="viz-rank__track" aria-hidden="true">
                      <span
                        className="viz-rank__bar"
                        data-some={row.value > 0 ? '' : undefined}
                        style={{ width: `${shareOf(row.value) * 100}%`, background: barColor }}
                      />
                    </span>
                    <span className="viz-rank__pct">{share(shareOf(row.value), shareOf(row.value) < 0.1 ? 1 : 0)}</span>
                  </span>
                </td>
                <td className="viz-rank__num">{formatValue(row.value)}</td>
                <td className="viz-rank__change">
                  <Change value={row.change} label={newLabel} />
                </td>
              </tr>
            )
          })}
          {/* Hold a short last page at full height, so the pager does not
              jump out from under the pointer on the way to it. */}
          {pages > 1
            ? Array.from({ length: pageSize - shown.length }, (_, i) => (
                <tr key={`pad-${i}`} className="viz-rank__pad" aria-hidden="true"><td colSpan={5} /></tr>
              ))
            : null}
        </tbody>
      </table>

      {pages > 1 ? (
        <div className="viz-rank__pager">
          <span className="viz-rank__count">
            {at * pageSize + 1}–{at * pageSize + shown.length} of {ordered.length}
          </span>
          <button
            type="button" className="viz-iconbtn" aria-label="Previous page"
            disabled={at === 0} onClick={() => setPage(at - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button" className="viz-iconbtn" aria-label="Next page"
            disabled={at >= pages - 1} onClick={() => setPage(at + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      ) : null}

      {hover && hovered?.detail && box.current ? (
        <Tooltip
          x={hover.x}
          y={hover.y}
          width={box.current.clientWidth}
          height={box.current.clientHeight}
          title={hovered.label}
          rows={hovered.detail.map((d) => ({ color: 'transparent', label: d.label, value: d.value }))}
          footer={detailFooter}
        />
      ) : null}
    </div>
  )
}

function Change({ value, label }: { value: RankRow['change']; label: string }) {
  if (value === 'new') return <span className="viz-rank__new">{label}</span>
  if (value == null || !Number.isFinite(value)) return <span className="viz-rank__flat">—</span>
  if (Math.abs(value) < FLAT) return <span className="viz-rank__flat">0%</span>
  return (
    <span className="viz-rank__delta">
      {value > 0 ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
      {signedPercent(value)}
    </span>
  )
}
