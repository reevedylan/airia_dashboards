#!/usr/bin/env node
/**
 * Palette gate for viz-kit.
 *
 * Reads the series colours and surfaces straight out of `src/theme/tokens.css`
 * and measures them — lightness band, chroma floor, colourblind separation,
 * normal-vision separation, contrast — in both light and dark mode.
 *
 * Run it after ANY change to the series hexes:
 *     node scripts/validate-palette.mjs
 *
 * Exits non-zero on a FAIL, so it drops straight into CI.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { validate } from './_validate_core.js'

/** The core reports rows as [name, state, detail]; normalise to PASS/WARN/FAIL. */
const GLYPH = { true: 'PASS', false: 'FAIL', pass: 'PASS', floor: 'WARN', fail: 'FAIL', relief: 'WARN' }
const rows = (result) => result.report.map(([check, state, detail]) => ({ check, state: GLYPH[state] ?? String(state), detail }))

const here = dirname(fileURLToPath(import.meta.url))
const cssPath = resolve(here, '../src/theme/tokens.css')
const css = readFileSync(cssPath, 'utf8')

/** Pull one declaration out of a specific rule block. */
function block(selectorSnippet) {
  const at = css.indexOf(selectorSnippet)
  if (at === -1) throw new Error(`Could not find "${selectorSnippet}" in tokens.css`)
  const open = css.indexOf('{', at)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') { depth--; if (depth === 0) return css.slice(open, i) }
  }
  throw new Error(`Unbalanced braces after "${selectorSnippet}"`)
}

function tokens(text) {
  const out = {}
  for (const m of text.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1].trim()] = m[2].trim()
  return out
}

const light = tokens(block(':root {'))
const dark = tokens(block(':root[data-theme="dark"]'))

const seriesOf = (t) => Array.from({ length: 8 }, (_, i) => t[`viz-series-${i + 1}`]).filter(Boolean)

const MODES = [
  { mode: 'light', slots: seriesOf(light), surface: light['viz-surface'] },
  { mode: 'dark', slots: seriesOf(dark), surface: dark['viz-surface'] },
]

let failed = false

const label = (ok) => (ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m')

for (const { mode, slots, surface } of MODES) {
  if (slots.length === 0) { console.error(`No series tokens found for ${mode}`); failed = true; continue }

  console.log(`\n\x1b[1m${mode.toUpperCase()}\x1b[0m  surface ${surface}  ·  ${slots.length} slots`)

  // All eight, adjacent pairs: the gate for stacks, bars and multi-line.
  const adjacent = validate(slots, { mode, surface, pairs: 'adjacent' })
  console.log(`  [${label(adjacent.ok)}] 8 slots, adjacent pairs  (stacked/grouped bars, multi-line)`)
  for (const row of rows(adjacent)) {
    if (row.state !== 'PASS') console.log(`         ${row.state}  ${row.check}: ${row.detail}`)
    if (row.state === 'FAIL') failed = true
  }

  // First three, every pair: the gate for donut / scatter / choropleth, where
  // any two slots can end up side by side.
  const trio = validate(slots.slice(0, 3), { mode, surface, pairs: 'all' })
  console.log(`  [${label(trio.ok)}] slots 1-3, all pairs      (donut, scatter, maps)`)
  for (const row of rows(trio)) {
    if (row.state !== 'PASS') console.log(`         ${row.state}  ${row.check}: ${row.detail}`)
    if (row.state === 'FAIL') failed = true
  }
}

// The one pair the dashboard puts opposite each other by meaning, not identity.
console.log('\n\x1b[1mSTATUS PAIRS IN USE\x1b[0m')
for (const { mode, slots, surface } of MODES) {
  // Status tokens are fixed across modes, so they live only in the :root block.
  const critical = (mode === 'light' ? light : dark)['viz-status-critical'] ?? light['viz-status-critical']
  const pair = [slots[0], critical]
  const r = validate(pair, { mode, surface, pairs: 'all' })
  const cvd = rows(r).find((x) => x.check.startsWith('CVD'))
  console.log(`  [${label(r.ok)}] ${mode}: series-1 vs status-critical (success vs error) — ${cvd?.detail ?? ''}`)
  if (!r.ok) failed = true
}

console.log(
  failed
    ? '\n\x1b[31mFAILED\x1b[0m — fix the marked checks before shipping.\n'
    : '\n\x1b[32mAll checks pass.\x1b[0m  A contrast WARN is not dismissable: that chart must keep visible labels or its table view.\n',
)
process.exit(failed ? 1 : 0)
