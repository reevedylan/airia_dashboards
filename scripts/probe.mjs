#!/usr/bin/env node
/**
 * Run an expression inside the running dashboard and print what it returns.
 *
 * The workhorse for checking anything the UI knows but a screenshot cannot
 * show — resolved windows, computed styles, folded numbers:
 *
 *   node scripts/probe.mjs "document.querySelector('.viz-extent').textContent"
 *   node scripts/probe.mjs --reload "…"   # load the page fresh first
 *
 * Because the page is served by Vite, a dynamic `import()` of any source
 * file works — which is how the aggregation is tested against real data
 * without a test runner.
 */
import { arg, connect, seedAndOpen } from './_cdp.js'

/* The expression is whatever is left once the flags and their values are
   taken out — not argv[2], which put `--reload` in the page the first time
   this script was used with a flag. */
const FLAGS_WITH_VALUE = ['url']
const positional = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) { positional.push(argv[i]); continue }
  if (FLAGS_WITH_VALUE.includes(argv[i].slice(2))) i++
}
const expression = positional.at(-1)
if (!expression) {
  console.error('usage: node scripts/probe.mjs [--reload] [--url URL] "<expression>"')
  process.exit(2)
}

const cdp = await connect()
if (process.argv.includes('--reload')) {
  const state = await seedAndOpen(cdp, arg('url', 'http://localhost:5173/'))
  if (state !== 'ready') console.error(`  (page: ${state})`)
}
const out = await cdp.evaluate(expression)
console.log(JSON.stringify(out, null, 1))
cdp.close()
process.exit(0)
