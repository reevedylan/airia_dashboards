# viz-kit

Dashboard charts built from plain SVG — no charting library, no runtime
dependency beyond React. Every component is self-sizing, interactive on hover
and keyboard, and reads all of its colour from one CSS file.

```bash
npm install
npm run dev                          # the dashboard
node scripts/validate-palette.mjs    # gate the palette (run after any colour change)
```

---

## For the UI team: the palette lives in one file

**`src/theme/tokens.css`** is the only file you need to touch. It is fully
commented and grouped: surfaces and ink, eight series slots, four reserved
status colours, a sequential ramp, plus radii and mark specs. Change a value
there and every chart, table, card and control follows, in both light and dark
mode.

There is also a live swatch sheet at the bottom of the dashboard
("Palette reference") that reads the computed value of each token in the
current theme, so it can never drift from the file.

### The three rules that keep it readable

1. **Series slots are assigned in order** (`--viz-series-1`, then `-2`, …) and
   never cycled. A ninth series folds into `--viz-other`, it does not get an
   invented hue.
2. **Status colours are reserved.** `--viz-status-*` means good / warning /
   serious / critical. They are never "series 4", and they always ship next to
   a text label so the colour is never the only signal.
3. **Re-run the validator after changing any series hex:**

   ```bash
   node scripts/validate-palette.mjs
   ```

   It measures, rather than eyeballs, five things in both light and dark mode:
   OKLCH lightness band, chroma floor, colourblind separation (protan /
   deutan / tritan ΔE), normal-vision separation, and WCAG contrast against
   the chart surface. It exits non-zero on a failure, so it drops into CI.

### Two palette decisions worth knowing about

- **Success is blue, not green.** Green-vs-red measured ΔE 4.1 under simulated
  deuteranopia — effectively one colour for ~5% of men. Blue vs the reserved
  critical red measures 23.8 (light) / 25.7 (dark). Red still means error;
  only the other half of the pair moved.
- **Ranked tables use one hue, not a colour per row.** A different pastel per
  row would encode nothing — the rows are nominal and already ordered by the
  number beside them. Instead each row sits on a bar whose width is its share
  of the largest value, so the colour carries the magnitude the reader came
  for.

Three light-mode slots (aqua, yellow, magenta) sit just under 3:1 against the
light surface. That is allowed, but it obliges the chart to keep either
visible labels or its table view. Every card here has the table toggle, so the
obligation is met — if you remove it, re-check those slots.

---

## The Airia gateway dashboard

Paste an Airia API key and the dashboard builds itself. A key is scoped to one
tenant, so a different key gives you that tenant's dashboard — which is how you
hand this to a customer.

```bash
npm install
npm run dev                      # http://localhost:5173
# or, to run the built app:
npm run build && npm start       # http://localhost:4173
```

Then paste the key in the page. Nothing else to configure.

### Why it needs to run locally

**The Airia API sends no `Access-Control-Allow-Origin` header**, so a browser
cannot call it directly however valid your key — a cross-origin `fetch` is
blocked, and the preflight for `x-api-key` returns 403. The page therefore
calls `/airia/...` on its own origin and something local forwards it: Vite's
proxy under `npm run dev`, `server.mjs` under `npm start`.

That means this is a **local tool**, not a link you can send. A customer runs
their own copy and pastes their own key.

> **Don't host the proxy for other people.** Every request through it carries
> the caller's API key, so whoever runs it can see those keys. `server.mjs`
> binds to `127.0.0.1` for that reason.
>
> If you want a link you *can* share, the blocker is one server-side change:
> CORS headers on `api/marketplace/v1/AIOperationExecutions`. With those, this
> becomes a static page anyone can open.

### Where the data lives

Nowhere. Rows are fetched into the tab, aggregated in the browser, and dropped
when you close it. No server stores anything and no tenant data touches disk —
which is a better privacy position than the snapshot file this replaced.

The key is held in memory. "Remember for this browser tab" is opt-in and uses
`sessionStorage`, which clears when the tab closes; leave it off on a shared
machine. The key is only ever sent as a request header — never in a URL, where
it would land in logs and history.

### What it shows

## Components

All exported from `src/components`:

| Component | Use it for |
|---|---|
| `LineChart` | Trend over time, one or many series, optional area wash. Crosshair + one tooltip listing every series. |
| `BarChart` | Dense columns; several series stack with a 2px surface gap. Per-column hover band and tooltip. |
| `DonutChart` | Part-to-whole at a glance. Caps at 6 arcs and folds the tail into "Other"; the centre is the readout. |
| `RankTable` | A ranked list where each row is its own bar. "Show all" past the limit. |
| `Sparkline` | Axis-free trend shape for tiles and cells. |
| `StatTile` | label · value · delta · trend, where a chart would be a single bar. |
| `Card` | The frame: title, hero figure, legend, plot, footer, and the table-view toggle. |
| `TableView` | The accessible twin of any chart. |
| `Legend`, `Tooltip` | Used by the charts; exported for custom ones. |
| `TimeRangeBar` | The preset range row that scopes everything below it. |

### Built for many marks, not seven

The brief was hundreds of thin marks at any timeframe, and that is the part
that needs real machinery rather than a prop:

- **`bandScale`** gives up the inter-bar gap before it gives up the bar, and
  floors the painted width at 1px — 2,000 columns in a 300px card still render
  as columns.
- **Every chart buckets before it draws.** `BarChart` reduces to the number of
  bars the card can actually paint (2px each); `LineChart` reduces to one
  vertex per `pxPerPoint` (default 4 — below ~3px the peaks overlap into a
  solid band and the shape stops being readable). Counts and money `sum`,
  rates and latencies `mean`.
- Bars cap at `--viz-bar-max` (24px), so a handful of bars never becomes a row
  of slabs; the leftover stays as air.

Switching 24H → 3M changes the sample count from 1,440 to 2,160 and the charts
hold their shape; nothing is hard-coded to a bucket count.

### Interaction

Hover and keyboard focus show the same thing, and nothing is hover-only —
every value is also in the table view. Line and bar charts snap to the nearest
x (you aim at a time, not at a 2px line); the hovered column gets a
full-height wash so a 1px bar is still findable. Arrow keys step along either
chart. Tooltips put the value in the strong position and key the series with a
short stroke of its colour; series names go in as text nodes, never as HTML.

## Verifying a change

```bash
npm run dev
# in another shell, with Chrome on a debug port:
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --remote-debugging-port=9222 --user-data-dir=/tmp/viz-chrome about:blank &

node scripts/shoot.mjs --out /tmp/a.png                        # plain render
node scripts/shoot.mjs --out /tmp/b.png --hover 600,330        # with the hover layer
node scripts/shoot.mjs --out /tmp/c.png --click "1490,93;193,93"  # dark mode, 24H
```

`--hover` reports whether the tooltip actually opened, so a missed coordinate
can't be mistaken for a working chart.

## Reusing the kit elsewhere

Copy `src/theme/`, `src/lib/`, `src/components/` and
`scripts/validate-palette.mjs`. Import `tokens.css` and `kit.css` once at your
entry point. `src/data/` (Airia loading) and `src/demo/` (the palette sheet) are
app-specific — the components take plain arrays (`x: number[]`,
`values: (number | null)[]`), so wiring them to a different API means replacing
that folder and nothing else. See `CLAUDE.md` for the full data contract,
including how to choose a reducer.
