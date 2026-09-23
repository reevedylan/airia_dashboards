#!/usr/bin/env node
/**
 * Drive every control once and report anything the console complains about.
 *
 *   node scripts/check-console.mjs
 *
 * React says most of what it has to say at runtime — key warnings, bad
 * nesting, state updates on unmounted components, failed prop types — and
 * none of it shows up in `tsc` or a screenshot. This clicks through each
 * range, both chart views, the calendar, both filters, all three breakdown
 * tabs and the theme toggle, then prints whatever was logged.
 *
 * Exits non-zero if anything was.
 */
import { connect, seedAndOpen, arg, wait } from './_cdp.js'

const url = arg('url', 'http://localhost:5173/')
const cdp = await connect()
const noisy = []

cdp.on('Runtime.consoleAPICalled', (p) => {
  if (!['error', 'warning', 'assert'].includes(p.type)) return
  noisy.push(`${p.type}: ${p.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300)}`)
})
cdp.on('Runtime.exceptionThrown', (p) =>
  noisy.push(`exception: ${p.exceptionDetails.exception?.description?.slice(0, 300)}`))

const state = await seedAndOpen(cdp, url)
if (state !== 'ready') { console.error(`Dashboard never became ready (${state}).`); process.exit(1) }

await cdp.evaluate(`(async () => {
  const s = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el && el.click()
  for (const r of ['24H', '7D', '14D', '1M', '3M']) {
    click([...document.querySelectorAll('.viz-segmented__btn')].find((b) => b.textContent === r)); await s(400)
  }
  for (const t of document.querySelectorAll('.viz-viewtoggle button')) { click(t); await s(250) }
  for (const t of document.querySelectorAll('.viz-tabs button, [role=tab]')) { click(t); await s(300) }
  click(document.querySelector('.viz-toolbar__actions .viz-btn')); await s(250)

  // a custom range: two clicks in the calendar
  click(document.querySelector('.viz-anchor__date')); await s(300)
  const days = [...document.querySelectorAll('.viz-cal__day')].filter((d) => !d.disabled)
  click(days[2]); await s(200); click(days[10]); await s(2500)

  // step, then home
  click(document.querySelectorAll('.viz-anchor__step')[0]); await s(2500)
  click(document.querySelector('.viz-anchor__now')); await s(2500)

  // both filters, and an isolated row
  for (const trigger of document.querySelectorAll('.viz-msel__trigger')) {
    click(trigger); await s(300)
    click(document.querySelector('.viz-msel__opt')); await s(600)
    click(document.querySelector('.viz-msel__action')); await s(600)
    document.body.click(); await s(200)
  }
  click(document.querySelector('.viz-rank tbody tr .viz-rank__pick')); await s(600)
  click(document.querySelector('.viz-btn--sm')); await s(400)
})()`)
await wait(1200)

cdp.close()
if (noisy.length) {
  console.log(`\x1b[31m${noisy.length} console message(s):\x1b[0m`)
  for (const m of noisy) console.log(`  ${m}`)
  process.exit(1)
}
console.log('\x1b[32mNo console errors or warnings.\x1b[0m')
process.exit(0)
