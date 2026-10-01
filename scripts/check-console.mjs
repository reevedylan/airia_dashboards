#!/usr/bin/env node
/**
 * Drive every control once and report anything the console complains about.
 *
 *   node scripts/check-console.mjs
 *
 * React says most of what it has to say at runtime — key warnings, bad
 * nesting, state updates on unmounted components, failed prop types — and
 * none of it shows up in `tsc` or a screenshot. This clicks through each
 * range, both chart views, every grain, a typed and a calendar-drawn
 * range, both filters, every breakdown tab, the theme toggle and the
 * weekly report, then prints whatever was logged.
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
  const openTime = async () => { click(document.querySelector('.viz-time__trigger')); await s(300) }
  for (const label of ['Last 24 hours', 'Last 7 days', 'Last 14 days', 'Last 30 days', 'Last 90 days']) {
    await openTime()
    click([...document.querySelectorAll('.viz-tp__quickitem')].find((b) => b.textContent.startsWith(label))); await s(500)
  }
  for (const t of document.querySelectorAll('.viz-viewtoggle button')) { click(t); await s(250) }
  for (const t of document.querySelectorAll('.viz-tabs button, [role=tab]')) { click(t); await s(300) }
  click(document.querySelector('.viz-toolbar__actions .viz-btn')); await s(250)

  // every grain the current window offers, then back to its default
  click(document.querySelector('.viz-grain__trigger')); await s(250)
  const grains = document.querySelectorAll('.viz-menu__item').length
  for (let i = 0; i < grains; i++) {
    click(document.querySelector('.viz-grain__trigger')); await s(250)
    click(document.querySelectorAll('.viz-menu__item')[i]); await s(900)
  }

  // an absolute range typed by hand, then one from the calendar
  await openTime()
  const [from, to] = document.querySelectorAll('.viz-tp__input input')
  const set = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  set(from, 'now-10d'); set(to, 'now-3d'); await s(100)
  click(document.querySelector('.viz-tp__apply')); await s(2500)
  await openTime()
  click(document.querySelector('.viz-tp__calbtn')); await s(300)
  const days = [...document.querySelectorAll('.viz-cal__day')].filter((d) => !d.disabled)
  click(days[2]); await s(200); click(days[10]); await s(200)
  click(document.querySelector('.viz-tp__apply')); await s(2500)

  // step back, then forward to where it was
  click(document.querySelectorAll('.viz-anchor__step')[0]); await s(2500)
  click(document.querySelectorAll('.viz-anchor__step')[1]); await s(2500)

  // both filters, and an isolated row
  for (const trigger of document.querySelectorAll('.viz-msel__trigger')) {
    click(trigger); await s(300)
    click(document.querySelector('.viz-msel__opt')); await s(600)
    click(document.querySelector('.viz-msel__action')); await s(600)
    document.body.click(); await s(200)
  }
  click(document.querySelector('.viz-rank tbody tr .viz-rank__pick')); await s(600)
  click(document.querySelector('.viz-btn--sm')); await s(400)

  // the weekly report: open it, step a week back and forward, copy, return
  const nav = (i) => click(document.querySelectorAll('.page__navlink')[i])
  nav(1); await s(2500)
  click(document.querySelectorAll('.viz-anchor__step')[0]); await s(2500)
  click(document.querySelectorAll('.viz-anchor__step')[1]); await s(1500)
  click(document.querySelector('.report__copy button')); await s(600)
  nav(0); await s(1500)
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
