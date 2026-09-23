# CLAUDE.md

Dependency-free dashboard components (`viz-kit`) plus an Airia gateway-usage
dashboard built on them. No charting library — everything is hand-rolled SVG.

## Layers (each depends only on the ones above)

```
src/theme/      colour — the ONLY place hex values exist
src/lib/        maths & hooks — no JSX, no colour
src/components/ the reusable kit
src/data/       Airia loading + range slicing
src/App.tsx     the dashboard
scripts/        ingest, palette validator, screenshot driver
```

`src/lib/` must never import from `src/components/`. Components must never
contain a colour literal — grep for `#` in `src/components/` should find none.

## Colour

All colour lives in `src/theme/tokens.css` as CSS custom properties, light and
dark. Components reference them via `src/theme/palette.ts` (`series(1)` →
`"var(--viz-series-1)"`).

- Series slots are assigned **in order** and never cycled. A 9th series folds
  into `--viz-other`.
- `--viz-status-*` are reserved for good/warning/serious/critical and always
  ship beside a text label.
- **The default palette seats yellow (slot 4) next to orange (slot 2)**, which
  is the one adjacent pair that fails the colourblind gate. Stacked series skip
  slot 4 — see the `C` map in `App.tsx`.
- After changing any series hex, or choosing a new stack order, run:
  ```
  node scripts/validate-palette.mjs
  ```
  It measures lightness band, chroma floor, CVD separation, normal-vision
  separation and contrast in both modes, and exits non-zero on failure.

## Ranges, buckets and time zones

Each range has a fixed bucket size, defined once in `RANGE_SPECS` in
`src/lib/airia/aggregate.ts`. The EXTENT comes in two kinds:

| Range | Bucket | Extent | Bars |
|---|---|---|---|
| 24H | 15 min | `count` 96 | 96 |
| 7D | 2 hr | `count` 84 | 84 |
| 14D | 4 hr | `count` 84 | 84 |
| 1M | 12 hr | `months` 1 | 56–62 |
| 3M | 1 day | `months` 3 | 89–92 |

- **`count`** — a fixed number of buckets ending with the one containing the
  anchor. Window length is `count x bucketMs`.
- **`months`** — a CALENDAR window, because a month is not 30 days. A 1M
  window ending 3 April starts on 4 March; a 3M window ending 3 June starts
  on 4 March too. One ending 31 March starts on 1 March — a whole calendar
  month — because the month arithmetic **clamps** the day (31 March less one
  month is 28 February, not 3 March).

The bar count of a calendar range therefore varies with the month, which is
the point: a fixed 30-day window walks off the calendar a little further
every month. Nothing may assume a constant count — `RangeBlock.bucketCount`
is `bounds.length`, derived. What has not changed is that **the bar count
never depends on card width**.

`windowFor()` is the single resolver for both kinds and for the comparison
window; `earliestBoundary()` folds over it rather than doing its own
arithmetic. Adding or changing a range means editing `RANGE_SPECS` in
`aggregate.ts` and `RANGES` in `TimeRangeBar.tsx` together.

**Buckets are aligned to local time, not UTC** (`ZONE`, default
`Australia/Sydney`). The 12-hour buckets must fall on local midnight and noon
to read as AM/PM; UTC alignment would put them at 10am/10pm and cut every
Australian day in half. `localFloor()` does this in **two passes** — the
offset is taken at `t`, then re-taken at the candidate boundary — because on a
daylight-saving night those differ and a single pass lands an hour off local
midnight. The `x` array is therefore shipped rather than derived: locally
aligned buckets are not a strict arithmetic grid across a DST change, and a
transition day's bucket is genuinely 23 or 25 hours long.

### Don't walk the grid backwards

A calendar window's boundaries come from `dayGrid()`, which builds forwards
over civil days and places each bucket start at the instant whose LOCAL
clock reads a multiple of the bucket size.

It cannot be a backward walk of `floor(b - 1, size)`. On the night daylight
saving ENDS the local day is 25 hours long, and two instants an hour apart
are both fixed points of the two-pass floor — so the walk emitted a spurious
one-hour bucket and a three-month window came out 93 bars instead of 92.
Stepping back by `size` instead breaks the other way: on the 23-hour day it
overshoots and skips a day entirely. Measured, in both directions.

What comes out is right on both nights: the April window has one 25-hour
daily bucket and one 13-hour half-day, the October window one 23-hour and
one 11-hour. Those are the true lengths of those days.

## Labelling a bucket

`bucketFormat(bucketMs, zone)` in `src/lib/format.ts` produces every x label.
Two rules, both learned from getting it wrong:

- **Derive the format from the BUCKET SIZE, never the chart's span.** The
  charts' fallback (`grainFor` + `fullDate`) infers a format from the total
  span, which put 7D (2-hour buckets), 14D (4-hour) and 1M (12-hour) into a
  date-only format — on 1M you could not tell AM from PM. Always pass
  `formatX` when the bucket size is known.
- **Render in the zone the buckets were aligned to**, not the viewer's. A
  bucket that starts at local midnight would otherwise read as an arbitrary
  hour for anyone outside that zone.

Labels name the span rather than just its start, because the question a reader
has is "which block is this?":

```
15 min   Tue 22 Sept · 20:30–20:45 AEST
2 hr     Tue 22 Sept · 20:00–22:00 AEST
4 hr     Tue 22 Sept · 20:00–24:00 AEST
12 hr    Tue 22 Sept · PM 12:00–24:00 AEST
1 day    Tue, 22 Sept 2026
```

A bucket ending at midnight is shown as `24:00`, not `00:00`. The end comes
from the next bucket's start, so a daylight-saving day's 23- or 25-hour bucket
is labelled with its real span rather than start + bucketMs.

## Card header layout

`Card` renders a header of **two fixed rows**, and the split is load-bearing:

- **Row one** — title, `controls` (the view toggle), then the table button
  pinned right. Nothing here changes width with the selected view.
- **Row two** — series keys, at a *fixed* `--viz-legend-h`, reserved whether
  or not a legend is present.

Don't put the toggle back beside the legend. A legend's width changes with the
series on show and wraps entirely at five items, so anything sharing its row
slides sideways — and down — every time the view changes. And row two needs a
fixed height rather than a minimum: a legend is a couple of pixels taller than
an empty row, which is enough to nudge the plot.

Two more rules that keep a card from resizing when a control appears:

- **Row two renders when `legend` is defined at all**, not when the card
  happens to have controls. Pass `legend={[]}` for a view with no keys to
  show and the row still holds its height; a card with no legend (the Models
  table) never gets one. Keying it off `controls` made the row appear and
  disappear along with a button.
- **Row one's height is fixed**, and an in-header control uses
  `ToolbarButton size="sm"` to fit inside it. The default button is taller
  than the row and stretched it.

For the same reason both views of a chart render a one-line footer note. If
only one view had one, the card would grow on toggle and shove everything
below it down the page.

Verified by measuring the toggle's and plot's bounding boxes in both views at
1600px and 640px; all four must be identical.

## The fact table

Each range ships ONE sparse fact table keyed by (bucket, user, model,
gateway), and `src/data/airia.ts` folds everything out of it: the KPI tiles,
both charts, and all three breakdowns.

It has to work this way because the filters are real scopes, not highlights
— filtering by gateway must recompute the *model* and *user* breakdowns too,
which pre-aggregated per-model series could not do. It stays cheap because
the combinations that actually occur are few: a few thousand facts across
all ranges, from 20k+ source rows. Folding on render is less work than
shipping every pre-aggregation would be.

`seriesFor(block, filter)` folds to dense per-bucket series;
`breakdown(block, dim, scope)` folds to per-model, per-user or per-gateway
totals with shares. **Add a dimension by adding a column to the facts, not
by adding another pre-aggregation** — `gatewayConfigurationId` was added
exactly that way, and the whole change was a column, a dictionary, an
`axis()` entry and a filter clause.

Two things bite when adding one:

- **`slim()` will drop it.** Rows are projected to `KEPT` as they arrive, so
  a field that is not listed there never reaches the fold — it is not a
  compile error, just a column of zeros. `gatewayConfigurationId` had to be
  added to `RawRow` *and* `KEPT`.
- **The comparison window has to learn about it too.** `PreviousWindow` is
  keyed by every SCOPE — now (user, gateway) pairs rather than per-user
  scalars — because a scoped window compared against an unscoped baseline
  reports a change that never happened. Types do not catch this: the old
  code indexed `spend[i]` by user position and kept compiling. Model stays
  out of it on purpose: isolate is a view, not a scope, and the tiles
  ignore it.

Verified by partitioning: the previous window summed over every gateway,
and again over every user, both equal the unpartitioned total exactly.

## Window anchoring

The window's DURATION (the range buttons) and its END (the anchor) are
independent. `App.tsx` holds `anchor: number | null`, where null is the live
window; `useAiriaLive(key, anchor)` folds at that anchor.

**An anchor is the last instant the window INCLUDES**, not the first it
excludes. The fold walks back from the bucket *containing* the anchor, so
anchoring on the following midnight instead drew a final empty bar for the
next day.

**Raw rows are cached in a ref**, so changing the anchor is a re-fold (~0.3s),
not a re-fetch (~9s). Only an anchor reaching past the cached span fetches,
and then only the missing older slice, which is prepended. Don't "simplify"
this into a refetch per step.

`stepWindow()` steps in the range's OWN units: calendar months for 1M and
3M, so a step back from a window ending 3 April lands on one ending 3 March
— contiguous with it, and still a whole month. A fixed 30-day step would
walk off the calendar. For the counted ranges it slides by
`count x bucketMs` and re-snaps a day-aligned anchor to the local-day grid,
because those durations are whole numbers of days and plain arithmetic moves
them an hour across a DST change — visible on 7D, where the last bar is two
hours wide.

### A preset always means "ending now"

Clicking 24H/7D/14D/1M/3M discards the anchor and any custom range and
jumps to the live window — including re-clicking the preset that is already
selected, which is the natural "put it back" gesture. A preset that kept
the old anchor made the buttons mean two things at once: how long the
window is, and, invisibly, where it still sits.

### The calendar picks a RANGE, in whole days

`Calendar.tsx` is a month view; `TimeRangeBar` hangs it off the anchor
control. It speaks civil days (`YYYY-MM-DD`) and nothing else:

- **Its arithmetic is UTC-based**, which is exact rather than sloppy,
  because a civil calendar is the same everywhere — September has 30 days in
  Sydney and in Reykjavik. Turning a day into an instant is `customSpec()`
  in `data/airia.ts`, the only place that knows the zone.
- **From is midnight, To is the last millisecond of the closing day**, both
  in `ZONE`. Verified across the offset change: 10 January resolves to
  13:00Z, 10 September to 14:00Z — the same local midnight either side of
  daylight saving, which UTC-based bounds would have got wrong by an hour.
- **No time of day, ever.** A window shorter than a day is what the 24H
  preset is for, and two controls answering one question is how a picker
  becomes a puzzle.
- **Two clicks.** First arms the start, the pointer previews the span, the
  second applies it immediately — no Apply button. The same day twice is a
  single day. Click order is irrelevant; the ends resolve low-to-high. After
  a completed range the next click starts a new one.
- **An invalid range is never expressible.** The span cap and the retention
  floor are enforced by DISABLING days — once a start is down, anything
  more than a year from it greys out — so there is nothing to validate and
  nothing to reject.

A custom range and a preset are mutually exclusive: choosing one clears the
other, and no preset is pressed while a drawn range is showing. The
chevrons work in both modes, stepping by the window's own length.

### Grain follows the span

`grainFor()` in `aggregate.ts` picks the bucket size for a custom range off
a ladder: 15m, 30m, 1h, 2h, 3h, 4h, 6h, 12h, then 1–4 days. Every sub-day
rung DIVIDES a day, so buckets still land on local midnight; every day-scale
rung is whole days. Nothing in between — a 36-hour bucket cannot be aligned
to local time at all.

The rule is "the finest grain under 100 bars, unless that drops below 60, in
which case take the finer one's overshoot": too few fat bars reads worse
than a few too many thin ones. Measured over every span from one day to a
year it stays between 60 and 118 bars.

**It reproduces each preset's hand-chosen grain exactly** — 1 day picks
15 min, 7 days 2 hours, 14 days 4 hours, 30 days 12 hours, 90 days 1 day —
so a custom range matching a preset draws the same chart. That is what
keeps the two modes comparable, and it is why 8h is deliberately NOT on the
ladder: it would have given a 30-day custom range a different grain from
the 1M preset over the same span.

At the one-year cap the grain is 4 days (92 bars). A week would undershoot
to ~52, which is exactly the clunkiness the floor exists to prevent.

### One fold, six windows

A custom range is not a second pipeline. `aggregate()` takes an optional
`CustomSpec` and folds it in the SAME pass as the five presets, out of the
same sparse fact table — so the user filter, both breakdowns, isolation and
the period comparison all work on it without knowing it is custom. Its
comparison period is the equal-length span immediately before, measured in
DAYS so a daylight-saving change cannot make it an hour longer than the
window it is compared against.

### Placing a row: slots, not floors

Rows find their bar by WALL-CLOCK SLOT — `Z.slot(t, size)` — for every
window built by `dayGrid`, which is the calendar ranges and any custom one.
That is how the grid defines its boundaries, so the two agree by
construction.

`Z.floor` cannot do this job. On the night the clocks go back it lands on a
boundary that is not in the grid, so **rows in the last hour of that day
were silently dropped** — measured: a row at 5 Apr 23:30 floors to "5 Apr
23:00", which is nothing. It also cannot express a multi-day grain at all,
since flooring to a 2-day multiple aligns to the epoch rather than to the
window. Whole-day grains therefore index every civil day they cover,
stopping at the window's end so a row just past it cannot land in the last
bar.

The counted presets (24H, 7D, 14D) still use the original instant-keyed
lookup and are untouched by this — including the April defect noted under
**Don't walk the grid backwards**, which still applies to them.

## Never go back to the key gate mid-session

`App.tsx` renders `KeyGate` when there is **no key, or the key was rejected**
(`load.auth`). Nothing else. It used to read
`load.status !== 'ready' || !block`, so any non-ready state showed the key
page — including a mid-session backfill when an anchor stepped past the
cached span, which reads as being logged out.

`LoadState` is therefore a flat record with `data` on it, not a union
discriminated by status: the last good fold is **held** through the next
load. While one runs, the previous render stays up at reduced opacity
(`Card`'s `loading` prop, plus `.strip[data-loading]`) under an inline
progress line. A non-auth error keeps the page too and says so in a banner —
the figures are the last complete ones, and throwing them away helps nobody.

The anchor control leads and the plot catches up: during a load the date
button shows the requested day while the resolved chip, which describes what
is *drawn*, dims (`data-stale`).

Two details that took measuring:

- **Say you are busy BEFORE taking the cache lock.** The foreground may wait
  on an in-flight backfill slice, and a window that has visibly changed while
  the page still shows the old one, with nothing moving, reads as a freeze.
- **But hold the announcement for `--viz-dur-grace`.** A cached re-fold
  settles in ~260ms; flashing a progress bar at it is worse than silence. The
  state is set immediately and truthfully; only its *appearance* is delayed,
  in CSS. Fading back is immediate — the delay lives on the `[data-loading]`
  rule, not the base one. Measured both ways: a cached step never shows the
  banner, a real fetch shows it at 220ms.

## The 365-day floor

Airia's logs expire at a year, so nothing older can be selected, fetched or
held. `RETENTION_DAYS` in `data/airia.ts` is the one definition, and it
bounds three things: `oldestEndDay()` (the calendar's `min` and the back
chevron's disabled state), the backfill target, and `needFrom` on every
fetch.

**The bound is on the whole window, not on the date you click.** A 3M window
ending one day inside retention would be two-thirds empty, so
`oldestEndDay()` is the end day whose window *starts* on the floor — for 3M
that is about 275 days ago, for 24H 365. Verified per range: every one of
them starts exactly on the floor day.

Switching range re-clamps the anchor (`clampAnchor`), because an anchor
that is legal for 24H can be older than 3M's oldest window.

One consequence worth keeping: near the floor the COMPARISON window falls
off the end of retention, so `App.tsx` drops the KPI deltas and says why.
Showing them would report a rise that is really a deletion.

## Prefetching history, and why a step back used to cost a fetch

After first paint, `useAiriaLive` reaches back to the **one-year retention
floor** in the background. Measured, before choosing:

| | rows | heap held |
|---|---|---|
| 180 days (what the ranges need) | 156,406 | ~122 MB raw |
| 365 days (retention) | 320,246 | ~249 MB raw, ~149 MB projected |

Not a bigger first load — that would have doubled a first paint for history
most sessions never open — and not raw rows either. `slim()` in
`aggregate.ts` projects each row to the fourteen fields the aggregation
reads as it arrives (~780 → ~470 bytes), which is what makes a year
affordable. Every row survives the projection, so the kept-of-fetched counts
still mean what they say. **Add a field to `RawRow` and add it to `KEPT`, or
it will be silently dropped.**

### Reach one step back FIRST

Stepping back one window needs rows three months older than anything the
first load fetched — the new window is three months back, and its own
comparison period is three months before *that*. So "previous 3M" was a
genuine cache miss no matter how much history was queued behind it.

`prefetchBoundary()` names that depth: the window before this one, plus its
comparison period. The backfill's FIRST slice goes straight there, and only
then walks the rest of the year in 90-day slices. It is the click people
actually make next.

It must stay in the background. Blocking the fold on that depth instead —
tried, measured — means every step prefetches the step after it, and first
paint went from 5.8s to 10.1s for nothing.

### Four things that were quietly paying twice

Each of these looked like "the fetch is slow" and was not. The step-back
went from ~9s to ~2.7s at its worst, and ~0.4s once the first slice lands.

- **A day per request.** `CHUNK_MS` was 24 hours, so six months was 184 round
  trips. Throughput is ~12k rows/s whatever the window, so a small window
  buys nothing and costs its own latency. Fifteen days: 29 requests for a
  whole year instead of ~365. Thirty days measured *slower* — the server is
  not linear in window size — so fifteen it is.
- **Taking the cache lock to read.** A window whose rows are already held
  needs no fetch, but it still queued behind whatever backfill slice was in
  flight: a 0.4s re-fold waiting 5s for history it was not going to read.
  The lock is for WRITING now. Reading while a slice lands is safe because a
  slice replaces the array rather than mutating it.
- **Discarding a slice that was fetching exactly what was wanted.** The
  foreground aborted the backfill on principle. When the slice already
  reaches as far back as the new view needs, killing it means re-requesting
  the same ninety days. It only aborts a slice that cannot help.
- **Committing rows on liveness instead of on the key.** The worst one. A
  slice would finish its three-second fetch and then throw the rows away
  because the anchor had moved while they were in flight — so the click
  waited for that slice AND paid for the same span again. Fetched rows are
  true whoever is waiting for them; liveness governs what is on screen, not
  what is in the cache.

### Keeping it safe

- **One writer at a time.** Foreground fold and background backfill extend
  the same array through a promise-chain mutex. Two overlapping fetches
  would prepend the same rows twice and double everything on the page.
- **`rowsBetween()` trims both ends** before folding, by binary search — the
  cache is ascending by construction. The newer end matters once the window
  is anchored in the past: those rows land in no bucket but were still being
  walked five ranges deep, and they inflated the footer's counts.
- **Bisection is real now.** A 365-day window returns exactly 200,000 of
  320,825 rows — the cap is `PAGE_LIMIT`, not a server-side size limit. A
  deliberately oversized 400-day window was pushed through `fetchAll` and
  came back whole, 320,826 rows after one split. That is what protects a
  tenant dense enough to fill a 15-day chunk.
- The API returns **403s under sustained parallel load** — a 900-request
  retry storm locked it out for minutes — but the limiter counts requests,
  and a year is now 29 of them, so background work runs at the same width as
  foreground work.

## Period comparison

The KPI tiles compare against the window immediately before the selected one,
of equal extent — equal length for a counted range, the same number of
CALENDAR months for 1M and 3M, so February is compared against January
rather than against 30 days. `earliestBoundary()` therefore reaches back
**twice** each range's extent — six calendar months for 3M, which is 181 to
184 days depending on where in the year it lands — and `aggregate()` accumulates those
older rows as per-user scalars (`RangeBlock.previous`) rather than a second
fact table: the tiles need three numbers, and the filter needs them split by
user.

The previous window's boundaries are *walked* on the same local-time grid, not
computed arithmetically, so a DST change cannot shift it.

"Previous window" means the duration immediately before **the anchored
window**, not before now — it moves with the anchor.

A comparison window that reaches past the retention floor is not shown at
all — see **The 365-day floor**.

A change past roughly tenfold is shown as a multiplier ("214k x") rather than
a percentage; a near-zero baseline produced "21388468%", which is accurate and
useless.

Deltas are **neutral** — direction and magnitude, no colour. More spend is not
inherently good or bad. A zero baseline reports "new"; both zero reports
nothing at all.

## Scoping and isolating

Two different mechanisms, and the difference matters:

- **The user and gateway filters are SCOPES.** They behave like changing the
  range: everything recomputes, including all three breakdowns. **An empty
  selection means ALL, not none** — treating it as none would blank the
  dashboard when someone unticks their last choice. The two INTERSECT: two
  users and one gateway means those users' traffic on that gateway.
- **Isolate is a VIEW on top of that scope.** It never escapes the filter, so
  the grey ghost is the filtered whole and the isolated share is a share of
  the filter, not of the tenant.

Isolate is **single-selection across all three dimensions**
(`{ dim, key } | null`), so isolating a gateway clears an isolated model and
vice versa. Two ghost overlays at once would be meaningless.

A controlled multi-select must expose a **relative** toggle (`onToggle(value)`),
not an absolute `onChange(nextSet)`. Computing the next Set from the `selected`
prop loses a toggle when two land in the same render batch, because both read
the same stale value — caught with two programmatic clicks in one tick.

`RankTable` is keyed by dimension in `App.tsx` so switching tabs remounts it.
Without that, a sort by "out $/M" on models silently carried over to users and
overrode the documented spend-descending default.

## Isolating a model

Clicking a row in the Models table shows that model alone in **both** charts —
the table is the single filter source, so isolation never applies to one chart
on its own. Three rules:

- **The unfiltered whole stays on screen, in BOTH views.** `BarChart` and
  `LineChart` each take a `ghost` prop and draw it in `--viz-other` behind the
  data — bars behind the stack, a filled area behind the lines. The ghost
  **joins the y-domain**. Not rescaling is the whole point: the isolated model
  keeps both its absolute shape and its size relative to the whole.

  The daily ghost compares per-bucket totals; the cumulative ghost compares
  running totals, so it passes `reducer: 'max'` — a running total must not be
  re-summed if buckets merge.

- **Everything the card shows must follow the isolation.** The cumulative
  series was originally derived from `summarise(block)`, which is always
  all-models, so clicking a model changed the daily bars and left the
  cumulative line untouched. Derive per-bucket totals from the plotted
  `tokens`/`cost` (which `breakdownFor()` may have replaced), never from the
  all-models summary. The card's headline figure follows too — showing the
  window total above a plot of one model misstates it by that model's share.
  The KPI strip keeps the all-models totals; the cards describe their plot.
- **Isolation is dropped when it stops matching.** A model with traffic in 3M
  may have none in 24H, so `active` is derived by checking the isolation
  against the range's own model list rather than trusting the stored value. The
  stored value is kept, so going back to 3M restores it.
- **Per-model bars need per-model-per-category data.** That is what the sparse
  `models` arrays in each range block are for; `breakdownFor()` scatters one
  model back onto the dense grid.

Selection in `RankTable` is marked with a ring, deliberately unlike the
proportional bar. The bar encodes magnitude and was being read as a selected
state — that ambiguity is why rows previously looked pre-selected.

## Stack segments

`BarChart` **drops** a stack segment shorter than `MIN_SEG_PX` rather than
drawing it. Forcing a minimum height on a negligible category turned it into a
detached tick floating above the bar: its own 2px surface gap pushed it clear
of the stack, so a rounding-error value read as a mark of its own. The gap is
likewise only carved out of segments comfortably larger than it. Values that
are too small to draw still appear in the tooltip, which is where that detail
belongs — verified by asserting the largest gap between consecutive painted
segments is exactly the intended 2px.

## Cumulative views

Both charts switch between daily bars and a cumulative line. Two rules:

- **Cumulative is always within the selected window.** `runningTotal()` runs
  over that range's own arrays, so it starts at zero and resets on every range
  change. Never accumulate across the whole ingest.
- **A running total must be reduced with `max`, never `sum`.** If buckets are
  ever merged for display, summing would add closing balances to each other.
  It is monotonic, so the largest value in a merged bucket is its close.

## Chart data contract

Charts take parallel arrays aligned **by index**:

```ts
x: readonly number[]                      // ms timestamps, ASCENDING, evenly spaced
values: readonly (number | null)[]        // same length as x
```

Nothing sorts for you. `null` means **no data** and renders as a break in the
line; it is not zero.

### Pick the reducer deliberately — this is the easiest thing to get wrong

| Measure | Reducer |
|---|---|
| counts, token totals, money | `sum` |
| latencies, durations | `mean` |
| peaks, SLO ceilings | `max` |
| **rates and ratios** | `mean` **plus `weights`** |

A rate averaged unweighted is a mean-of-means and is simply wrong — on this
data it was out by double digits of percentage points. Pass the ratio's
denominator as `weights` and the reducer computes `sum(v*w)/sum(w)`.
No card uses `weights` today, but any rate series added later must.

Two related traps, learned the hard way on this dataset:

- **A ratio over a tiny denominator is noise, not a rate.** A 0% cache rate
  derived from an 8-token probe plots identically to a sustained cache miss.
  Floor the denominator and emit `null` below it, and say so on the card.
- **Prefer the form of a metric that moves.** A cache-hit rate pinned near
  100% conveys almost nothing. Where a ratio is flat, the same fact expressed
  in dollars, or as a cumulative total against its own average pace, carries
  far more.

`reducer` lives per-series on `LineChart` but is a chart-level prop on
`BarChart` (stacked bars share an axis, so mixing reducers within one would be
meaningless).

## Architecture: the key is pasted, the fetch is local

The dashboard builds itself from a key pasted in the UI. There is no ingest
step and nothing on disk.

**The Airia API sends no `Access-Control-Allow-Origin` header**, so the browser
cannot call it directly — a cross-origin `fetch` fails and the preflight for
`x-api-key` returns 403. Verified, not assumed. So:

```
browser --/airia/...--> same origin --> proxy --> prodaus.api.airia.ai
                     (no CORS)          (Vite in dev, server.mjs in prod)
```

Both proxies exist for that one reason. Don't "simplify" by calling the API
directly from the client; it cannot work until CORS is enabled upstream.

`server.mjs` binds to 127.0.0.1 on purpose: it forwards whatever key the page
sends, so hosting it for other people would expose their keys. Each tenant runs
their own copy.

### One aggregation, not two

`src/lib/airia/aggregate.ts` is the only implementation — pure, no DOM, no
network. A separate CLI ingest used to exist and drifted; don't reintroduce a
second copy.

`src/lib/airia/fetchAll.ts` owns the windowed fetch.

### Things that bite

- **Filter to `executionSourceType === 'Gateway'`.** The API returns every
  execution type and non-Gateway rows outnumber Gateway roughly three to one,
  so a missing filter inflates every figure on the page. This happened: the
  client path shipped without it and read $2,325 against a true $1,643. The
  footer prints kept-of-fetched counts so it cannot go unnoticed again.
- **Never retry a cancelled request.** `withRetry` treats anything that is
  not `WindowTooLarge` or `AuthError` as transient, so an abort used to sit
  through two backoff sleeps before giving up — two seconds of dead air
  between changing the window and the page reacting, and re-sent requests
  nobody wanted. It checks `signal.aborted` first now.
- **Silent truncation.** A 404 with an empty body means "response too large",
  not "not found", and a 200 can return fewer `items` than `totalCount`. Both,
  plus timeouts, mean *bisect the window and retry the halves*. Checking the
  status code alone is not enough.
- **Providers disagree about `input`.** Anthropic:
  `total = input + cached + output`. OpenAI: `total = input + output`, with
  `input` **already including** cached. Stacking raw `input + cached` would
  double-count on OpenAI rows. `normaliseTokens()` detects which convention a
  row follows from its own arithmetic.
- **`additionalCharges` is a dynamically-keyed map.** Seen so far:
  `AnthropicWriteCache5MinTokens`, `AnthropicWriteCache1HourTokens`,
  `AnthropicWebSearchRequests`. Sum unknown keys; never hardcode one.
- **Never blend a $/M rate across token categories.** Cached input bills at
  exactly 0.1x the input rate and output at exactly 5x, on every model. A
  blended rate ranks models by cache hit rate rather than by price, and it
  inverted the ordering on real data. Report the rate card:
  `inputRate = inputCost / inputCount`, same for output. Blending across
  *models* for a per-user rate is fine — that is what a per-user rate means.
- **Write-cache tokens have a cost but no count**, so they can never appear in
  any per-token rate. They are a line item on the spend chart only.
- **`totalTokenAmountConsumed` has two conventions**, switched on
  2026-06-18: before, it excluded `additionalCharges`; after, it includes
  them. Clean cutover. **Always sum spend from the components, never read
  `total`** — that is correct on both sides. The reconciliation check accepts
  either rule and counts the legacy ones; checking only the new rule reported
  65% of older rows as mismatched.
- **Money arrives as 11-decimal strings.** Accumulate as scaled integers, then
  convert once. Not floats.
- `Date.parse` handles the 7-digit fractional seconds natively in V8.
- Don't filter `BalanceUsedGreaterThan=0` — it drops rows with real token cost
  and zero balance drawn.
- **`balanceUsed` does not apply to gateway traffic** and is zero throughout,
  so it is deliberately not surfaced. Don't add a card for it.

### Key handling

In memory by default (`src/lib/apiKey.ts`). "Remember" is opt-in and uses
`sessionStorage`, not `localStorage`, so a key does not outlive the tab on a
shared machine. Never put it in a URL, a log, or the page title. `maskKey()`
for anything shown on screen.

## Gateway configurations

`gatewayConfigurationId` is on every recent Gateway row and is a third
breakdown dimension and a second scope. Rows from before it was recorded —
all of them a year ago — group under `NO_GATEWAY`, for the same reason
`SERVICE_KEY` exists: a breakdown that silently drops rows makes every
percentage wrong.

**Names come from somewhere else, and may not come at all.** Executions
carry only a UUID. `src/lib/airia/gateways.ts` fetches names from a separate
endpoint and is built so that failure is ordinary: any non-OK response
yields no names, `gatewayLabel()` falls back to the first 8 characters of
the id, and nothing else on the page notices. That is not defensive
padding — the names endpoint is a different resource and may want a
different key or scope than the one pasted into the dashboard, so a version
that only worked when the lookup succeeded would be broken for most keys.

The fetch is deliberately outside `LoadState`: the dashboard neither waits
for it nor fails with it, and labels simply re-render if names arrive late.

`NAMES_URL` and `readNames()` are the two things to change when the endpoint
is confirmed; `readNames` is already shape-tolerant about the envelope and
the field names.

## User attribution

`userEmail` is empty on the rows made with the tenant's standard service key
rather than an individual's. **Its share is not a fixed fraction and the
docs used to claim one**: measured across this tenant's year, every row 12
months ago had no user, against about 1% of the last 30 days. Quote it for a
window or not at all. They are
grouped under an explicit `Standard Key (service)` member rather than dropped,
so the Users breakdown always reconciles with the totals — omitting a third of
the spend would make every percentage wrong. The label comes from
`meta.serviceKeyLabel`, set once in the ingest; don't hardcode it in the UI.

Per-user rates (`in $/M`, `out $/M`) blend across the MODELS that user used,
which is what a per-user rate means. That is not the forbidden blend: blending
across *categories* is what inverts the ordering, because cached input is a
tenth of the input rate.

## Privacy — the repo is public

`github.com/reevedylan/airia_dashboards` is public, and rows carry user emails.

Nothing needs gitignoring any more because **no tenant data is written to
disk**: rows are fetched into the tab, folded in the browser, and dropped when
it closes. `.env` and the old `public/data/*.json` and `.cache/` paths stay in
`.gitignore` as a backstop so a stray snapshot cannot be committed.

Before committing, verify with `git check-ignore` rather than by eye, and grep
the diff for `akey_`/`ak-` prefixes and `@` addresses.

## Verifying a change

```
npx tsc -b && npm run build
node scripts/validate-palette.mjs
npm run dev            # paste a key in the UI
```

Then **look at it** — the validator checks colour, not layout:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --remote-debugging-port=9222 --user-data-dir=/tmp/viz-chrome about:blank &

node scripts/shoot.mjs --out /tmp/a.png
node scripts/shoot.mjs --out /tmp/b.png --hover 600,330        # says if the tooltip opened
node scripts/shoot.mjs --out /tmp/c.png --click-sel '.sheet > summary'
```

Check every range preset, both themes, and 640px width. `--hover` reports
whether the hover layer actually opened, so a missed coordinate can't be
mistaken for a working chart.
