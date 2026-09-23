# Airia gateway usage dashboard

A spend-and-usage dashboard for Airia's LLM gateway. Paste an API key and it
builds itself: token volume, cost broken down by billing category, per-model
and per-user breakdowns, and a rate card showing what each model actually
costs.

A key is scoped to one tenant, so a different key gives you that tenant's
dashboard. That is the point — it is meant to be handed to a customer who runs
it against their own data.

Charts are hand-rolled SVG. There is no charting library.

---

## Quick start

```bash
npm install
npm run dev                    # http://localhost:5173
```

Paste an Airia API key in the page. Nothing else to configure.

To run the built app instead:

```bash
npm run build && npm start     # http://localhost:4173
```

## Why it runs locally

**The Airia API sends no `Access-Control-Allow-Origin` header.** A cross-origin
browser fetch is blocked and the preflight for `x-api-key` returns 403. So a
static page where someone pastes a key cannot work, however valid the key.

Instead the page calls `/airia/…` on its **own** origin and something local
forwards it — Vite's proxy in development, `server.mjs` for the built app:

```
browser ──/airia/…──▶ same origin ──▶ proxy ──▶ prodaus.api.airia.ai
                     (no CORS)              (server-to-server)
```

That makes this a local tool, not a link you can send. Each tenant runs their
own copy.

> **Don't host the proxy for other people.** Every request through it carries
> the caller's API key, so whoever runs it can read those keys. `server.mjs`
> binds to `127.0.0.1` for that reason.
>
> If you want a link you *can* share, the blocker is a single upstream change:
> CORS headers on `api/marketplace/v1/AIOperationExecutions`. With those, this
> becomes a static page anyone can open.

## Where the data lives

Nowhere. Rows are fetched into the tab, aggregated in the browser, and dropped
when you close it. No server stores anything and nothing touches disk.

The key is held in memory. *Remember for this browser tab* is opt-in and uses
`sessionStorage`, which clears when the tab closes — leave it off on a shared
machine. The key is only ever sent as a request header, never in a URL where it
would reach logs and browser history.

---

## What it shows

**Three KPI tiles** — token spend, tokens, executions — for the current scope,
each with a change against the immediately preceding window of equal length
(14D compares against the 14 days before it). The arrow is deliberately
**neutral**: more spend is neither good nor bad, so colouring it green or red
would assert a judgement the number cannot make. A zero baseline reads "new"
rather than a divide-by-zero. The comparison respects the user filter and is
independent of isolate.

**Two charts**, each switchable between *Daily* (stacked bars by category) and
*Cumulative* (running total from zero at the window start):

| Chart | Categories |
|---|---|
| Tokens | cached input · input · output |
| Token spend | write cache · cached input · output · input · other |

They stay separate deliberately. They are different signals and they diverge
when the usage mix shifts toward pricier models.

**A breakdown card** with two tabs, *By model* and *By user*, sharing one
column set: spend, % spend, tokens in, tokens out, % tokens, and the per-row
rate card (`in $/M`, `out $/M`). Searchable, sortable, show-top-N.

### Time ranges

Each range has a fixed bucket size and bar count, so what you see never depends
on how wide the window happens to be:

| Range | Bucket | Bars |
|---|---|---|
| 24H | 15 min | 96 |
| 7D | 2 hr | 84 |
| 14D | 4 hr | 84 |
| 1M | 12 hr | 60 |
| 3M | 1 day | 90 |

Buckets align to **local time** (`Australia/Sydney` by default), not UTC. The
12-hour buckets have to land on midnight and noon to read as AM/PM, and daily
buckets on local midnight — UTC alignment would put them at 10am/10pm and split
every Australian day in half. Daylight saving is handled.

### Moving the window

Duration and position are separate controls. The range buttons pick how long a
window is; the chevrons step it back or forward by its own length, and the
calendar jumps to "this duration, ending on that day". Forward is disabled at
the live window — you can't step into the future.

The calendar is a month view that picks a **day**, not an instant, so the
window lands on the same grid the bars do: it ends when that local day ends,
which every bucket size divides. On 3M the last bar is that whole day, on 1M
its afternoon, on 24H its last quarter hour — and every window starts on a
local midnight. There is deliberately no second date field: the duration
belongs to the range buttons, and a dragged span would make the bucket size
depend on how wide you happened to drag. The days the window covers are
banded in the grid so that relationship is visible while you pick.

Whenever the window isn't the live one, the resolved range is shown beside the
buttons with a **Jump to now** link, so it is always obvious when you're
looking at history.

Stepping is instant: raw rows are cached, so a new anchor is a re-fold rather
than a re-fetch. The first load fetches the 180 days the ranges themselves
need, then keeps reaching back to the one-year retention limit in the
background, so stepping rarely needs the network at all. When it does, the
dashboard you were looking at stays on screen, dimmed, with a progress line
— it never drops back to the key page. Only a rejected key does that.

### Filtering and isolating

Two different mechanisms:

- **The user filter is a scope.** A searchable multi-select beside the range
  tabs. Pick users and *everything* recomputes against only their data — KPI
  tiles, both charts, both breakdowns — exactly like changing the range. An
  empty selection means all users.
- **Clicking a row isolates it.** Both charts then show that model or user
  alone, with the *currently scoped* whole behind it in grey on the same scale,
  so absolute shape and share read at once. Isolate sits on top of the filter
  rather than escaping it, and only one row across both tabs can be isolated at
  a time.

---

## How it works

```
fetchAll.ts   windowed fetch, bisecting when the API truncates
aggregate.ts  raw rows  ──▶  one sparse fact table per range
data/airia.ts fact table ──▶  folded series, breakdowns, totals
App.tsx       composition
```

Each range is **one sparse fact table keyed by (bucket, user, model)**, and
everything on the page folds out of it. It has to be that shape because the
user filter is a real scope: filtering by user must recompute the *model*
breakdown, which a pre-aggregated per-model series could not do. It stays cheap
because only ~1,000 combinations actually occur across all five ranges, from
~22k source rows.

`src/lib/airia/aggregate.ts` is pure — no DOM, no network — and is the only
aggregation implementation. A separate CLI ingest used to exist and drifted out
of sync; don't reintroduce a second copy.

### The API's sharp edges

- **It silently truncates.** A 404 with an empty body means "response too large
  to build", not "not found", and a 200 can return fewer `items` than
  `totalCount`. Both, plus timeouts, mean *bisect the window and retry the
  halves*. Checking the status code alone is not enough.
- **Filter to `executionSourceType === 'Gateway'`.** Non-Gateway rows outnumber
  Gateway roughly 3:1, so a missing filter inflates every figure on the page.
  The footer prints kept-of-fetched counts so it cannot go unnoticed.
- **Providers disagree about `input`.** Anthropic reports
  `total = input + cached + output`; OpenAI reports `total = input + output`
  with `input` *already including* cached. Stacking raw `input + cached` would
  double-count on OpenAI rows, so the convention is detected per row from its
  own arithmetic.
- **`additionalCharges` is a dynamically-keyed map** (5-minute and 1-hour
  write-cache variants, web-search requests). Unknown keys are summed, never
  hardcoded.
- **`totalTokenAmountConsumed` has two conventions.** Airia changed it on
  **18 June 2026**: before that it *excluded* `additionalCharges`, after it
  *includes* them — a clean cutover with no overlap. Spend is therefore summed
  from the components and never read from `total`, which is right either way.
  The reconciliation check accepts both rules and reports how many rows used
  the older one; accepting only the new rule flagged 65% of older rows as
  corrupt when they were merely older.
- **Money arrives as 11-decimal strings** and is accumulated as scaled
  integers, then converted once. Floats drift over 10⁵ rows.
- **~37% of rows carry no user.** Those requests used the tenant's standard
  service key rather than an individual's, and are grouped under an explicit
  `Standard Key (service)` member — dropping them would hide a third of the
  spend and make every percentage wrong.

Every row's token counts and charge amounts are checked to sum to the reported
totals, and the mismatch count is printed in the page footer. It has been zero
on ~22k rows.

### Measurement decisions that aren't obvious

- **Never blend a $/M rate across token categories.** Cached input bills at
  exactly 0.1× the input rate and output at exactly 5×, on every model. A
  blended rate therefore ranks models by *cache hit rate* rather than by price
  — on real data it showed the cheapest model per token as the most expensive.
  The rate card divides cost by count within one category.
- **Write-cache tokens have a cost but no count**, so they can never appear in
  a per-token rate. They are a line item on the spend chart only.
- **A running total is reduced with `max`, not `sum`.** Merging buckets for
  display would otherwise add closing balances to each other.
- **Rates are volume-weighted.** `LineChart` takes a `weights` array so a ratio
  series aggregates as `Σ(v·w)/Σw`; averaging per-bucket ratios is a
  mean-of-means and was badly out on this data.
- **Hairline stack segments are dropped, not drawn.** Forcing a minimum height
  on a negligible category turned it into a detached tick floating above the
  bar. Its value still appears in the tooltip.

---

## Colour

**`src/theme/tokens.css` is the only file with colour in it.** Surfaces, ink,
eight categorical series slots, four reserved status colours, a sequential
ramp, plus radii and mark specs — light and dark. Components reference tokens
by role, so re-branding is one file and nothing else changes. There is a live
swatch sheet at the bottom of the dashboard that reads the computed values.

Three rules keep it readable:

1. Series slots are assigned **in order** and never cycled. A ninth series
   folds into `--viz-other` rather than inventing a hue.
2. `--viz-status-*` are reserved for good/warning/serious/critical and always
   ship beside a text label.
3. After changing any series hex, run the validator:

   ```bash
   node scripts/validate-palette.mjs
   ```

   It measures — rather than eyeballs — lightness band, chroma floor,
   colourblind separation (protan/deutan/tritan ΔE), normal-vision separation
   and WCAG contrast, in both modes, and exits non-zero on failure.

One trap worth knowing: the default palette seats yellow beside orange, the one
adjacent pair that fails the colourblind gate. Stacked series skip slot 4 — see
the `C` map in `App.tsx`.

---

## Layout

```
src/
  theme/       colour — the only place hex values exist
  lib/
    airia/     fetch + aggregation (pure, no React)
    *.ts       scales, SVG paths, formatting, hooks
  components/
    charts/    LineChart, BarChart, RankTable (+ DonutChart, Sparkline, unused here)
    primitives/Card, Legend, Tooltip, TableView, StatTile, MultiSelect, Tabs,
               KeyGate, TimeRangeBar, Calendar
  data/        folds the fact table into series and breakdowns
  App.tsx      the dashboard
scripts/
  validate-palette.mjs   palette gate
  shoot.mjs              headless-Chrome screenshots, incl. hover states
server.mjs     serves the build and proxies /airia
```

`lib/` never imports from `components/`, and no component contains a colour
literal.

## Verifying a change

```bash
npx tsc -b && npm run build
node scripts/validate-palette.mjs
npm run dev                            # paste a key
```

Then **look at it** — the validator checks colour, not layout:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --remote-debugging-port=9222 --user-data-dir=/tmp/viz-chrome about:blank &

node scripts/shoot.mjs --out /tmp/a.png
node scripts/shoot.mjs --out /tmp/b.png --hover 600,330    # reports if the tooltip opened
node scripts/shoot.mjs --out /tmp/c.png --click-sel '.viz-viewtoggle button:last-child'
```

Check every range, both themes, both chart views and 640px width. `--hover`
says whether the hover layer actually opened, so a missed coordinate can't be
mistaken for a working chart.

`CLAUDE.md` holds the working notes: the data contract, the reducer table, and
the mistakes worth not repeating.

## Known gaps

- **Only tested against one tenant's key.** The per-tenant path is structurally
  sound but unverified across tenants.
- **The bisecting fetch has never fired in anger.** No 90-day window has been
  large enough to trigger a truncation, so that branch is untested against a
  real 404.
- **`balanceUsed` is zero throughout** — it doesn't apply to gateway traffic,
  which bills against the caller's own provider credentials — so it isn't
  surfaced.
- **`totalTokens` on the gateway feed excludes cached tokens.** This dashboard
  uses `AIOperationExecutions` instead, which reports them, but be aware if you
  compare against the gateway feed directly.
