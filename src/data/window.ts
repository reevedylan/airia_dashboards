/**
 * The window: which instants the dashboard is looking at.
 *
 * Everything zone-aware lives here — the one `makeZone` instance, civil-day
 * conversion, how a preset or a drawn range steps through time, and the
 * retention floor that bounds all of it. Pure functions over instants and
 * `YYYY-MM-DD` days; nothing here fetches or renders.
 */

import {
  isCalendar, makeZone, customWindow, grainFor, grainOptions, windowFor, withGrain, RANGE_SPECS,
  type CustomSpec,
} from '../lib/airia/aggregate'
import { addDays, addMonths, spanDays, type Day } from '../lib/day'
import type { RangeKey } from '../components'

/** A custom window as the calendar produces it: two civil days, inclusive. */
export interface DayRange {
  from: Day
  to: Day
}

export const DAY_MS = 86_400_000

/**
 * The zone every bucket is aligned to.
 *
 * It was hardcoded to `Australia/Sydney`, which is right for the tenant this
 * was built against and wrong for everyone else: a reader in London would
 * have had their days cut at 14:00 or 15:00 local while the cards printed
 * "Australia/Sydney" underneath. Buckets mean nothing unless they land on
 * the reader's own midnight.
 *
 * Resolved ONCE, at module load, in this order:
 *
 *   1. `?tz=Europe/London` in the URL — for sharing a view, or for looking
 *      at a tenant's traffic in the zone their team works in rather than
 *      your own.
 *   2. The browser's own zone.
 *   3. `Australia/Sydney`, which is where this started.
 *
 * Once rather than reactively because everything downstream — the offset
 * cache, the day formatter, every bucket boundary — is derived from it, and
 * a zone that could change under a fold would have to invalidate all of it
 * for a setting nobody changes twice in a session. Change it by reloading
 * with a different `tz`.
 */
function resolveZone(): string {
  const candidates = [
    new URLSearchParams(globalThis.location?.search ?? '').get('tz'),
    // Always a valid IANA name where it exists at all.
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    FALLBACK_ZONE,
  ]
  for (const zone of candidates) {
    // An unknown name makes Intl THROW, which would take the page with it —
    // so a bad `?tz=` has to fall through rather than break the dashboard.
    if (zone && isZone(zone)) return zone
  }
  return FALLBACK_ZONE
}

const FALLBACK_ZONE = 'Australia/Sydney'

function isZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: name })
    return true
  } catch {
    return false
  }
}

export const ZONE = resolveZone()

/** Offsets are cached inside, so one instance for the life of the module. */
const Z = makeZone(ZONE)

/**
 * Platform retention is a year. Airia's logs expire at 365 days, so that is
 * a hard floor on three separate things: how far back a window may be
 * SELECTED, how far the background backfill reaches, and how far a fetch
 * will ask for. Past it there is nothing to find, and a window that reached
 * there would quietly show a partly-empty span as if it were real.
 */
export const RETENTION_DAYS = 365
export const RETENTION_MS = RETENTION_DAYS * DAY_MS

/** The oldest instant the source still holds. */
export const retentionFloor = (): number => Date.now() - RETENTION_MS


/* ------------------------------------------------------------ local days -- */

const isoDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
})

/** The local day containing `t`, as `YYYY-MM-DD` in the data's zone. */
export function dayOf(t: number): string {
  return isoDay.format(new Date(t))
}

/**
 * The LAST INSTANT of a local day — one millisecond before midnight.
 *
 * That is what a window anchor means: the last moment included, not the
 * first moment excluded. Anchoring on the next midnight instead puts that
 * midnight inside the bucket the fold walks back from, so picking the 10th
 * drew a final, empty bar for the 11th.
 *
 * Midnight is a boundary every bucket size divides, so a window that ends
 * here lands on the same grid the bars do whichever range is selected: on
 * 90D the last bar is that whole day, on 30D its PM half, on 24H its last
 * quarter hour.
 */
function endOfDay(day: Day): number {
  const [y, m, d] = day.split('-').map(Number)
  return Z.midnight(y, m, d + 1) - 1
}

/** The instant a local day BEGINS — midnight, in the data's zone. */
function startOfDay(day: Day): number {
  const [y, m, d] = day.split('-').map(Number)
  return Z.midnight(y, m, d)
}

/**
 * Resolve a picked pair of days into the window the fold needs.
 *
 * Whole local days, always: midnight on the first to the last millisecond
 * of the last. The grain defaults to one derived from the span — see
 * `grainFor` — so the chart keeps a readable bar count from one day to a
 * year without anyone picking a bucket size. `grain` overrides it, and is
 * honoured only when it is one `grainOptions` would offer for this span.
 */
export function customSpec({ from, to }: DayRange, grain?: number | null): CustomSpec {
  const a = from <= to ? from : to
  const b = from <= to ? to : from
  const start = startOfDay(a)
  const end = endOfDay(b)
  const native = grainFor(end - start + 1)
  const ok = grain != null && grainOptions(rangeDays({ from: a, to: b }) * DAY_MS, native).includes(grain)
  return { from: start, to: end, bucketMs: ok ? grain : native }
}

/** Days in a picked range, counted inclusively. */
export const rangeDays = ({ from, to }: DayRange): number => spanDays(from, to)

/**
 * Move a window anchor by `ms`, keeping it on the local-day grid if it was
 * already there.
 *
 * Plain arithmetic drifts a window by an hour across a daylight-saving
 * change, which on a 2-hour bucket is a visibly different last bar. A live
 * anchor is an arbitrary instant and is left alone.
 */
function slideAnchor(from: number, ms: number): number {
  const to = from + ms
  // Anchors sit on the last millisecond of a day, so test the boundary that
  // follows them.
  if (Z.floor(from + 1, DAY_MS) !== from + 1) return to
  const end = to + 1
  const below = Z.floor(end, DAY_MS)
  // The next local midnight: 36 hours on lands inside the following day
  // whether it is 23, 24 or 25 hours long.
  const above = Z.floor(below + DAY_MS + DAY_MS / 2, DAY_MS)
  return (end - below <= above - end ? below : above) - 1
}

/**
 * How long a window is, for choosing which grains it can be cut into.
 *
 * Nominal rather than measured — a window spanning a daylight-saving change
 * is an hour off — because the question is which bucket sizes divide it,
 * and on the civil calendar they all still do.
 */
export function windowSpanMs(range: RangeKey, custom: DayRange | null): number {
  if (custom) return rangeDays(custom) * DAY_MS
  const spec = RANGE_SPECS[range]
  return isCalendar(spec) ? spec.months * 30 * DAY_MS : spec.count * spec.bucketMs
}

/**
 * The civil days a preset window covers, computed from the window being
 * ASKED FOR rather than read off the fold on screen.
 *
 * That distinction is the whole point. While a step loads, the page holds
 * the previous fold, so taking the start from its first bucket and the end
 * from the new anchor labelled the pager with half of each: stepping 24H
 * back a day read "29 Sept – 30 Sept", then "29 Sept 2026", then "28 Sept –
 * 29 Sept". Both ends come from the same `windowFor` the fold will use, so
 * the label is right the moment the chevron is clicked.
 */
export function windowDays(range: RangeKey, anchor: number | null, grainMs?: number | null): DayRange {
  const at = anchor ?? Date.now()
  const w = windowFor(Z, withGrain(RANGE_SPECS[range], grainMs), at)
  return { from: dayOf(w.bounds[0] ?? at), to: dayOf(at) }
}

/** The grain a window uses when nobody has picked one. */
export function nativeGrain(range: RangeKey, custom: DayRange | null): number {
  return custom ? customSpec(custom).bucketMs : RANGE_SPECS[range].bucketMs
}

/** How many whole days a fixed-count preset spans. */
const presetDays = (range: RangeKey): number => {
  const spec = RANGE_SPECS[range]
  return isCalendar(spec) ? 0 : (spec.count * spec.bucketMs) / DAY_MS
}

/**
 * The oldest day a window of this range may END on.
 *
 * Chosen so the window itself starts no earlier than the retention floor:
 * the bound is on the whole span, not just on the date you click, because a
 * 90D window ending one day inside retention would still be mostly empty.
 */
export function oldestEndDay(range: RangeKey): Day {
  const floor = dayOf(retentionFloor())
  const spec = RANGE_SPECS[range]
  return isCalendar(spec)
    // The inverse of calendarStartDay: the end day whose window starts here.
    ? addDays(addMonths(floor, spec.months), -1)
    : addDays(floor, presetDays(range) - 1)
}

/** Clamp an anchor into the selectable range — used when the range changes
 *  under an anchor that was legal for the old one. */
function clampAnchor(range: RangeKey, anchor: number | null): number | null {
  if (anchor == null) return null
  return Math.max(anchor, endOfDay(oldestEndDay(range)))
}

/**
 * Move the window one step, in the range's OWN units.
 *
 * A calendar range steps by calendar months, so stepping back from a window
 * ending 3 April lands on one ending 3 March — contiguous with it, and
 * still a whole month. Stepping a fixed 30 days instead would walk the
 * window off the calendar a little further every month. Returns null for
 * the live window.
 */
export function stepWindow(range: RangeKey, from: number | null, dir: -1 | 1): number | null {
  const spec = RANGE_SPECS[range]
  const step = (t: number, d: number) => isCalendar(spec)
    ? endOfDay(addMonths(dayOf(t), d * spec.months))
    : slideAnchor(t, d * spec.count * spec.bucketMs)
  const now = Date.now()
  const next = step(from ?? now, dir)
  /*
   * Forward onto the live window returns to LIVE, not to a fixed anchor.
   *
   * A step back from live anchors at "a week before the click", so a step
   * forward lands on the click itself — which by then is a few seconds in
   * the past. Treating that as history left the › chevron enabled on what
   * was plainly the latest window, and one more click did nothing visible.
   * If a further step would pass now, this one IS the latest window.
   */
  if (next >= now || (dir > 0 && step(next, 1) >= now)) return null
  return clampAnchor(range, next)
}

/**
 * Slide a custom range by its own length, keeping it whole.
 *
 * The chevrons mean the same thing in both modes — the window before or
 * after this one — so a custom range steps by its own span rather than
 * doing nothing. Clamped at both ends: never past today, never past
 * retention, and never silently resized.
 */
export function stepRange(range: DayRange, dir: -1 | 1): DayRange {
  const days = rangeDays(range)
  const shifted = { from: addDays(range.from, dir * days), to: addDays(range.to, dir * days) }
  const floor = dayOf(retentionFloor())
  const today = dayOf(Date.now())
  if (shifted.from < floor) return { from: floor, to: addDays(floor, days - 1) }
  if (shifted.to > today) return { from: addDays(today, -(days - 1)), to: today }
  return shifted
}


/**
 * Builds the dashboard from a pasted API key, in the browser.
 *
 * The Airia API sends no CORS headers, so the requests go to `/airia/...` on
 * this origin and a proxy forwards them — see `src/lib/airia/fetchAll.ts`.
 * Nothing is persisted: no server, no tenant data on disk, and the key lives
 * only in this tab.
 */


/** The comparison period a custom range is measured against. */
export const customPrevFrom = (spec: CustomSpec): number => customWindow(Z, spec).prevFrom
