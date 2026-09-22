export interface TableColumn {
  key: string
  label: string
  align?: 'left' | 'right'
}

export interface TableViewProps {
  caption: string
  columns: readonly TableColumn[]
  rows: readonly Record<string, string>[]
  /** Long series get scrolled rather than truncated — no value is dropped. */
  maxHeight?: number
}

/**
 * The accessibility twin every chart ships with. Whatever the tooltip shows,
 * this shows without a pointer — so a tooltip enhances and never gates.
 */
export function TableView({ caption, columns, rows, maxHeight = 260 }: TableViewProps) {
  return (
    <div className="viz-tableview" style={{ maxHeight }} tabIndex={0}>
      <table>
        <caption className="viz-sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" style={{ textAlign: c.align ?? 'left' }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c, j) => {
                const content = row[c.key] ?? ''
                return j === 0
                  ? <th key={c.key} scope="row" style={{ textAlign: c.align ?? 'left' }}>{content}</th>
                  : <td key={c.key} style={{ textAlign: c.align ?? 'right' }}>{content}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
