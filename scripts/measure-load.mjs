#!/usr/bin/env node
/**
 * What the dashboard costs to load, and what a step back costs afterwards.
 *
 *   node scripts/measure-load.mjs
 *
 * These are the numbers the fetch and cache decisions in CLAUDE.md rest on,
 * and they are worth re-measuring against a real tenant before changing any
 * of it — chunk size, concurrency, how far the backfill reaches. Opinions
 * about fetch strategy age badly; a measurement does not.
 *
 * Reports first paint, how long the background backfill takes to reach the
 * retention floor, the request count either side of first paint, and what
 * stepping the window back costs at a few moments after load.
 */
import { connect, seedAndOpen, arg, wait, SETTLE } from './_cdp.js'

const url = arg('url', 'http://localhost:5173/')
const cdp = await connect()

/* ---------------------------------------------------- first paint + backfill */
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
await cdp.seedKey()
await cdp.send('Page.navigate', { url })

let paint = null
const deadline = Date.now() + 180_000
let done = null
while (Date.now() < deadline) {
  const v = await cdp.evaluate(`(() => {
    const note = document.querySelector('.page__note')?.textContent ?? ''
    return { ready: !!document.querySelector('.strip') && !document.querySelector('.page__busy'),
             done: /back to/.test(note) && !/still reaching back/.test(note), t: performance.now() }
  })()`)
  if (v?.ready && paint == null) paint = v.t
  if (paint != null && v?.done) { done = v.t; break }
  await wait(250)
}

const stats = await cdp.evaluate(`(() => {
  const rs = performance.getEntriesByType('resource').filter((r) => r.name.includes('/airia/'))
  const before = rs.filter((r) => r.startTime < ${paint ?? 0}).length
  const sorted = rs.map((r) => r.duration).sort((a, b) => a - b)
  return { requests: rs.length, beforePaint: before, afterPaint: rs.length - before,
           medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
           note: document.querySelector('.page__note')?.textContent.match(/([\\d,]+) rows held, back to (\\S+)/)?.slice(1) ?? [] }
})()`)

console.log('\x1b[1mLoad\x1b[0m')
console.log(`  first paint            ${(paint / 1000).toFixed(1)}s`)
console.log(`  full year cached       ${done ? (done / 1000).toFixed(1) + 's' : 'not reached'}`)
console.log(`  requests               ${stats.requests} (${stats.beforePaint} to first paint, ${stats.afterPaint} backfilling)`)
console.log(`  median request         ${stats.medianMs}ms`)
console.log(`  held                   ${stats.note[0] ?? '?'} rows, back to ${stats.note[1] ?? '?'}`)

/* ---------------------------------------------------------- cost of a step */
console.log('\n\x1b[1mStepping the window back\x1b[0m')
for (const delay of [0, 3000]) {
  await cdp.send('Page.navigate', { url })
  const state = await (await import('./_cdp.js')).waitForDashboard(cdp)
  if (state !== 'ready') { console.log(`  (dashboard not ready: ${state})`); continue }
  const r = await cdp.evaluate(`(async () => {
    const s = (ms) => new Promise((res) => setTimeout(res, ms))
    await s(${delay})
    const cached = document.querySelector('.page__note')?.textContent.match(/back to (\\S+)/)?.[1]
    const t0 = performance.now()
    document.querySelectorAll('.viz-anchor__step')[0].click()
    let fetched = false
    for (let i = 0; i < 400; i++) {
      const b = document.querySelector('.page__busy')
      if (b && /Fetching/.test(b.textContent)) fetched = true
      if (i > 3 && !b) break
      await s(100)
    }
    return { ms: Math.round(performance.now() - t0), fetched, cached }
  })()`)
  console.log(`  clicked ${String(delay / 1000).padStart(3)}s after paint  ${String(r.ms).padStart(6)}ms  ${r.fetched ? 'fetched' : 'from cache'}  (held back to ${r.cached})`)
}

cdp.close()
process.exit(0)
