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

Each range has a fixed bucket size and bar count, defined once in
`RANGE_SPECS` in `src/lib/airia/aggregate.ts`:

| Range | Bucket | Bars | Window |
|---|---|---|---|
| 24H | 15 min | 96 | 24 h |
| 7D | 2 hr | 84 | 7 d |
| 14D | 4 hr | 84 | 14 d |
| 1M | 12 hr | 60 | 30 d |
| 3M | 1 day | 90 | 90 d |

Window length is always `count x bucketMs`. The ingest emits each range
already bucketed, so the client does a lookup, not a slice-and-downsample, and
the bar count never depends on card width. Adding or changing a range means
editing `RANGE_SPECS` in `aggregate.ts` and `RANGES` in `TimeRangeBar.tsx` together.

**Buckets are aligned to local time, not UTC** (`ZONE`, default
`Australia/Sydney`). The 12-hour buckets must fall on local midnight and noon
to read as AM/PM; UTC alignment would put them at 10am/10pm and cut every
Australian day in half. `localFloor()` does this in **two passes** — the
offset is taken at `t`, then re-taken at the candidate boundary — because on a
daylight-saving night those differ and a single pass lands an hour off local
midnight. The `x` array is therefore shipped rather than derived: locally
aligned buckets are not a strict arithmetic grid across a DST change, and a
transition day's bucket is genuinely 23 or 25 hours long.

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

Each range ships ONE sparse fact table keyed by (bucket, user, model), and
`src/data/airia.ts` folds everything out of it: the KPI tiles, both charts, and
both breakdowns.

It has to work this way because the user filter is a real scope, not a
highlight — filtering by user must recompute the *model* breakdown too, which a
pre-aggregated per-model series cannot do. It stays cheap because the
combinations that actually occur are few: about a thousand facts across all
five ranges, from 21k source rows. Folding on render is less work than
shipping every pre-aggregation would be.

`seriesFor(block, filter)` folds to dense per-bucket series;
`breakdown(block, dim, users)` folds to per-model or per-user totals with
shares. Add a dimension by adding a column to the facts, not by adding
another pre-aggregation.

## Period comparison

The KPI tiles compare against the window immediately before the selected one,
of equal length. `earliestBoundary()` therefore reaches back **twice** each
range's bar count — 180 days for 3M — and `aggregate()` accumulates those
older rows as per-user scalars (`RangeBlock.previous`) rather than a second
fact table: the tiles need three numbers, and the filter needs them split by
user.

The previous window's boundaries are *walked* on the same local-time grid, not
computed arithmetically, so a DST change cannot shift it.

Deltas are **neutral** — direction and magnitude, no colour. More spend is not
inherently good or bad. A zero baseline reports "new"; both zero reports
nothing at all.

## Scoping and isolating

Two different mechanisms, and the difference matters:

- **The user filter is a SCOPE.** It behaves like changing the range:
  everything recomputes, including both breakdowns. **An empty selection means
  ALL users, not none** — treating it as none would blank the dashboard when
  someone unticks their last choice.
- **Isolate is a VIEW on top of that scope.** It never escapes the filter, so
  the grey ghost is the filtered whole and the isolated share is a share of
  the filter, not of the tenant.

Isolate is **single-selection across both dimensions** (`{ dim, key } | null`),
so isolating a user clears an isolated model and vice versa. Two ghost overlays
at once would be meaningless.

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

## User attribution

`userEmail` is **empty on about 37% of gateway rows**: those requests were made
with the tenant's standard service key rather than an individual's. They are
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
