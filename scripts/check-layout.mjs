#!/usr/bin/env node
/**
 * The layout invariants CLAUDE.md says to MEASURE rather than eyeball.
 *
 *   node scripts/check-layout.mjs
 *
 * Each one is here because it broke once:
 *
 *  1. Toolbar controls share one height and one baseline. They used to size
 *     themselves from their own padding, leaving the anchor 15px shorter
 *     than the range buttons beside it.
 *  2. A card does not resize when its view toggles. A legend's width changes
 *     with the series on show, so anything sharing its row slid sideways —
 *     and down — on every toggle.
 *  3. The toolbar does not re-lay-out when the window moves. An off-live
 *     chip appearing used to push the key chip onto a second row.
 *  4. The calendar popover stays inside the viewport, and the page never
 *     scrolls sideways.
 *
 * Exits non-zero on failure, so it drops into CI beside the palette gate.
 */
import { connect, seedAndOpen, arg, wait, SETTLE } from './_cdp.js'

const url = arg('url', 'http://localhost:5173/')
const cdp = await connect()
const state = await seedAndOpen(cdp, url)
if (state !== 'ready') {
  console.error(`Dashboard never became ready (${state}). Is the dev server up and AIRIA_API_KEY set?`)
  process.exit(1)
}

let failed = false
const report = (ok, name, detail) => {
  if (!ok) failed = true
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}`)
  if (detail) console.log(`         ${detail}`)
}

/* 1. one row, one height ------------------------------------------------ */
await cdp.resize(1600, 1000)
await wait(400)
const bar = await cdp.evaluate(`(() => {
  const els = [...document.querySelectorAll('.viz-segmented, .viz-anchor, .viz-msel__trigger, .viz-keychip, .viz-toolbar__actions .viz-btn')]
  const boxes = els.map((e) => e.getBoundingClientRect())
  return { heights: [...new Set(boxes.map((b) => Math.round(b.height)))], tops: [...new Set(boxes.map((b) => Math.round(b.top)))], n: els.length }
})()`)
report(bar.heights.length === 1 && bar.tops.length === 1,
  'toolbar controls share one height and baseline',
  `${bar.n} controls · heights ${JSON.stringify(bar.heights)} · tops ${JSON.stringify(bar.tops)}`)

/* 2. a card does not resize on toggle ----------------------------------- */
for (const width of [1600, 640]) {
  await cdp.resize(width, 1000)
  await wait(350)
  const card = await cdp.evaluate(`(async () => {
    const s = (ms) => new Promise((r) => setTimeout(r, ms))
    const box = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(',') }
    const snap = () => ({ toggle: box(document.querySelector('.viz-viewtoggle')), plot: box(document.querySelector('.viz-card__body')), card: box(document.querySelector('.viz-card')) })
    const before = snap()
    document.querySelector('.viz-viewtoggle button:last-child').click(); await s(450)
    const after = snap()
    document.querySelector('.viz-viewtoggle button:first-child').click(); await s(450)
    return { before, after, same: JSON.stringify(before) === JSON.stringify(after) }
  })()`)
  report(card.same, `card holds its box across a view toggle at ${width}px`,
    card.same ? `toggle ${card.before.toggle} · plot ${card.before.plot}` : `${JSON.stringify(card.before)} -> ${JSON.stringify(card.after)}`)
}

/* 3. moving the window does not move the toolbar ------------------------ */
for (const width of [1600, 1400, 1280, 1024]) {
  await cdp.resize(width, 1000)
  await wait(350)
  const step = await cdp.evaluate(`(async () => {
    const settle = ${SETTLE}
    const box = () => Object.fromEntries([...document.querySelectorAll('.viz-toolbar__controls > *, .viz-toolbar__actions')]
      .map((e) => { const r = e.getBoundingClientRect(); return [e.className.split(' ')[0], [r.x, r.y, r.width].map(Math.round).join(',')] }))
    const now = document.querySelector('.viz-anchor__now')
    if (now && !now.disabled) { now.click(); await settle() }
    const live = box()
    document.querySelectorAll('.viz-anchor__step')[0].click(); await settle()
    const past = box()
    const moved = Object.keys(live).filter((k) => live[k] !== past[k])
    return { moved, rowsLive: new Set(Object.values(live).map((v) => v.split(',')[1])).size,
             rowsPast: new Set(Object.values(past).map((v) => v.split(',')[1])).size }
  })()`)
  report(step.moved.length === 0 && step.rowsLive === step.rowsPast,
    `toolbar is unchanged by stepping the window at ${width}px`,
    step.moved.length ? `moved: ${step.moved.join(', ')}` : `${step.rowsLive} row(s), nothing moved`)
}

/* 4. popover fits, page never scrolls sideways -------------------------- */
await cdp.resize(640, 900)
await wait(350)
const pop = await cdp.evaluate(`(async () => {
  const s = (ms) => new Promise((r) => setTimeout(r, ms))
  document.querySelector('.viz-anchor__date').click(); await s(350)
  const cal = document.querySelector('.viz-cal')?.getBoundingClientRect()
  const vw = document.documentElement.clientWidth
  const out = { fits: !!cal && cal.left >= 0 && cal.right <= vw, right: cal && Math.round(cal.right), vw,
                overflowX: document.documentElement.scrollWidth > vw }
  document.body.click()
  return out
})()`)
report(pop.fits && !pop.overflowX, 'calendar fits the viewport at 640px with no sideways scroll',
  `right edge ${pop.right} of ${pop.vw} · page overflow ${pop.overflowX}`)

cdp.close()
console.log(failed ? '\n\x1b[31mFAILED\x1b[0m — a layout invariant broke.\n' : '\n\x1b[32mAll layout checks pass.\x1b[0m\n')
process.exit(failed ? 1 : 0)
