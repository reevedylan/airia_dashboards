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

A rate averaged unweighted is a mean-of-means and is simply wrong. On this
dataset the cache-hit rate read **79.2%** unweighted against a true **96.6%** —
a 17-point error. Pass the ratio's denominator as `weights` and the reducer
computes `sum(v*w)/sum(w)`.

Also: a ratio over a tiny denominator is noise, not a rate. `src/data/airia.ts`
nulls any bucket under `MIN_RATE_DENOMINATOR`, and the card says so in its
footer. Don't silently drop that caveat.

`reducer` lives per-series on `LineChart` but is a chart-level prop on
`BarChart` (stacked bars share an axis, so mixing reducers within one would be
meaningless).

## The Airia API — things that bite

Source: `AIOperationExecutions`, windowed by `startTime`/`endTime`, key in
`AIRIA_API_KEY` (`.env`, gitignored). All ~30 fields come back on the list
query, not just the three the original spec documented.

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
- **Write-cache tokens have a cost but no count.** So any `$/M` figure must
  divide *counted-token cost* by *counted tokens* — that's what `costTokens`
  is for. Using total cost inflates low-volume models without bound.
- **Money arrives as 11-decimal strings.** Accumulate as scaled integers
  (`toScaled`), convert once at the end. Not floats.
- `Date.parse` handles the 7-digit fractional seconds natively in V8; the
  regex truncation the spec mentions is a Python-only workaround.
- Don't filter `BalanceUsedGreaterThan=0` — it drops exactly the passthrough
  rows (real cost, zero balance) that the dashboard is about.

## Privacy — the repo is public

`github.com/reevedylan/airia_dashboards` is public. Rows carry `userEmail`,
`userFirstName`, `userLastName`.

- The ingest projects away every personal field before writing its cache, so
  even the gitignored `.cache/` holds none.
- `public/data/*.json` is gitignored: aggregates aren't PII but they disclose
  tenant spend.
- Before committing, confirm `git status` shows no `.cache/` and no
  `public/data/`.

## Verifying a change

```
node scripts/ingest-airia.mjs --days 90     # reconciliation is printed; 0 mismatches expected
npx tsc -b && npm run build
node scripts/validate-palette.mjs
npm run dev
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
