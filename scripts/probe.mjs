#!/usr/bin/env node
/**
 * Run an expression inside the running dashboard and print what it returns.
 *
 * The workhorse for checking anything the UI knows but a screenshot cannot
 * show — resolved windows, computed styles, folded numbers:
 *
 *   node scripts/probe.mjs "document.querySelector('.viz-extent').textContent"
 *   node scripts/probe.mjs "(async () => { const m = await import('/src/lib/airia/aggregate.ts'); return Object.keys(m.RANGE_SPECS) })()"
 *
 * Because the page is served by Vite, a dynamic `import()` of any source
 * file works — which is how the aggregation is tested against real data
 * without a test runner.
 */
import { arg, connect, seedAndOpen } from './_cdp.js'

const cdp = await connect()
if (arg('reload', null) !== null) await seedAndOpen(cdp, arg('url', 'http://localhost:5173/'))
const out = await cdp.evaluate(process.argv[2])
console.log(JSON.stringify(out, null, 1))
cdp.close()
process.exit(0)
