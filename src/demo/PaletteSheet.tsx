import { useEffect, useState } from 'react'

/**
 * Swatch sheet for design handoff.
 *
 * Reads the live computed value of every token, so it always shows what the
 * app is actually rendering in the current theme — not a copy that can drift
 * from `tokens.css`.
 */

const GROUPS: Array<{ title: string; note: string; tokens: string[] }> = [
  {
    title: 'Series (categorical)',
    note: 'Assigned in order, never cycled. Slots 1–3 are safe for any chart form; 4–8 for stacks, bars and lines. A 9th series folds into "Other".',
    tokens: [
      'viz-series-1', 'viz-series-2', 'viz-series-3', 'viz-series-4',
      'viz-series-5', 'viz-series-6', 'viz-series-7', 'viz-series-8', 'viz-other',
    ],
  },
  {
    title: 'Status (reserved)',
    note: 'Only when the colour means good or bad. Never reused as a series, and always paired with a label.',
    tokens: ['viz-status-good', 'viz-status-warning', 'viz-status-serious', 'viz-status-critical'],
  },
  {
    title: 'Sequential (magnitude)',
    note: 'One hue, light to dark. Used for inline table bars, heatmaps and any continuous scale.',
    tokens: ['viz-seq-100', 'viz-seq-200', 'viz-seq-300', 'viz-seq-400', 'viz-seq-500', 'viz-seq-600', 'viz-seq-700'],
  },
  {
    title: 'Surfaces & ink',
    note: 'Chart chrome. Gridlines and axes stay one step off the surface so they never compete with the data.',
    tokens: [
      'viz-page', 'viz-surface', 'viz-surface-raised', 'viz-surface-sunken',
      'viz-text-primary', 'viz-text-secondary', 'viz-text-muted', 'viz-grid', 'viz-axis',
    ],
  },
]

export function PaletteSheet() {
  const [values, setValues] = useState<Record<string, string>>({})

  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement)
      const next: Record<string, string> = {}
      for (const g of GROUPS) for (const t of g.tokens) next[t] = cs.getPropertyValue(`--${t}`).trim()
      setValues(next)
    }
    read()
    const mo = new MutationObserver(read)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => mo.disconnect()
  }, [])

  return (
    <details className="sheet">
      <summary>
        Palette reference
        <span> · live values for the current theme · edit <code>src/theme/tokens.css</code></span>
      </summary>

      <div className="sheet__body">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3>{g.title}</h3>
            <p>{g.note}</p>
            <ul>
              {g.tokens.map((t) => (
                <li key={t}>
                  <span className="sheet__chip" style={{ background: `var(--${t})` }} aria-hidden="true" />
                  <code>--{t}</code>
                  <span className="sheet__hex">{values[t] || '—'}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </details>
  )
}
