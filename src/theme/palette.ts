/**
 * Typed handles onto the CSS custom properties defined in `tokens.css`.
 *
 * Components never write a hex value — they pass one of these strings into
 * an SVG `fill` / `stroke`, so the browser resolves it against whichever
 * theme is active. To re-brand, edit `tokens.css`; nothing here changes.
 */

export const SERIES_SLOTS = 8 as const

/** Categorical slot, 1-indexed. Slots are assigned in order, never cycled. */
export type SeriesSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export const series = (slot: SeriesSlot): string => `var(--viz-series-${slot})`

/** The de-emphasis / "Other" grey. Where a 9th series goes. */
export const other = 'var(--viz-other)'

/** Reserved state colours. Never use these as a categorical series. */
export const status = {
  good: 'var(--viz-status-good)',
  warning: 'var(--viz-status-warning)',
  serious: 'var(--viz-status-serious)',
  critical: 'var(--viz-status-critical)',
} as const

/** One-hue ramp for magnitude. 100 = near zero, 700 = maximum. */
export const sequential = [
  'var(--viz-seq-100)',
  'var(--viz-seq-200)',
  'var(--viz-seq-300)',
  'var(--viz-seq-400)',
  'var(--viz-seq-500)',
  'var(--viz-seq-600)',
  'var(--viz-seq-700)',
] as const

export const ink = {
  primary: 'var(--viz-text-primary)',
  secondary: 'var(--viz-text-secondary)',
  muted: 'var(--viz-text-muted)',
} as const

export const chrome = {
  surface: 'var(--viz-surface)',
  surfaceRaised: 'var(--viz-surface-raised)',
  surfaceSunken: 'var(--viz-surface-sunken)',
  grid: 'var(--viz-grid)',
  axis: 'var(--viz-axis)',
  border: 'var(--viz-border)',
} as const

/**
 * Assign colours to a list of entities **by identity, not by rank**, so
 * filtering the list never repaints the survivors. Anything past slot 8
 * (or past `max`) collapses into the "Other" grey.
 */
export function assignSeriesColors<T>(
  items: readonly T[],
  key: (item: T) => string,
  max: number = SERIES_SLOTS,
): Map<string, string> {
  const out = new Map<string, string>()
  let slot = 1
  for (const item of items) {
    const k = key(item)
    if (out.has(k)) continue
    out.set(k, slot <= Math.min(max, SERIES_SLOTS) ? series(slot as SeriesSlot) : other)
    slot += 1
  }
  return out
}
