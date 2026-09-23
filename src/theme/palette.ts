/**
 * Typed handles onto the CSS custom properties defined in `tokens.css`.
 *
 * Components never write a hex value — they pass one of these strings into
 * an SVG `fill` / `stroke`, so the browser resolves it against whichever
 * theme is active. To re-brand, edit `tokens.css`; nothing here changes.
 */

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

