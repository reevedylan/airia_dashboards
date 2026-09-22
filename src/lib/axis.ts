/** Axis label helpers shared by the cartesian charts. */

/** Rough width of a tick label at 11px, in px. Cheap, and only ever used to
 *  size the gutter — being a pixel or two out costs nothing. */
const CHAR_PX = 6.4

/**
 * Width to reserve for the y-axis labels. Measured from the labels rather
 * than fixed, so "$1,000.00" doesn't spill out of the card the way a
 * hard-coded gutter lets it.
 */
export function axisGutter(labels: readonly string[], enabled: boolean): number {
  if (!enabled || labels.length === 0) return 0
  const widest = labels.reduce((m, l) => Math.max(m, l.length), 0)
  return Math.min(96, Math.max(26, Math.round(widest * CHAR_PX) + 12))
}
