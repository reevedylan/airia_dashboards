#!/usr/bin/env node
/**
 * Screenshot the running dashboard, optionally after interacting with it —
 * so the hover layer (crosshair, tooltip) can be eyeballed, not assumed.
 *
 *   node scripts/shoot.mjs --out /tmp/a.png
 *   node scripts/shoot.mjs --out /tmp/b.png --hover 600,330
 *   node scripts/shoot.mjs --out /tmp/c.png --click-sel '.viz-anchor__date'
 *   node scripts/shoot.mjs --out /tmp/d.png --width 640 --theme dark
 *
 * Needs headless Chrome on :9222 — see `_cdp.js`. The API key comes from
 * AIRIA_API_KEY in the environment.
 */
import { arg, connect, seedAndOpen, wait } from './_cdp.js'

const url = arg('url', 'http://localhost:5173/')
const out = arg('out', '/tmp/shot.png')
const hover = arg('hover', null)
const click = arg('click', null)
/** Click by CSS selector — steadier than guessing pixel coordinates. */
const clickSel = arg('click-sel', null)
const theme = arg('theme', null)
const width = Number(arg('width', 1600))
const height = Number(arg('height', 1000))
/** Extra settle time after the dashboard reports itself ready. */
const settle = Number(arg('settle', 400))

const cdp = await connect()
await cdp.resize(width, height)
const state = await seedAndOpen(cdp, url)
console.log(`  page: ${state}`)
if (theme) await cdp.evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`)
await wait(settle)

// Several clicks: "x,y;x,y" — e.g. flip the theme, then change the range.
for (const step of (click ? click.split(';') : [])) {
  const [x, y] = step.split(',').map(Number)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
  }
  await wait(450)
}

for (const sel of (clickSel ? clickSel.split(';') : [])) {
  const hit = await cdp.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'; el.click(); return 'clicked' })()`,
  )
  console.log(`  click ${sel}: ${hit}`)
  await wait(450)
}

if (hover) {
  const [x, y] = hover.split(',').map(Number)
  // Two moves: the first settles pointerenter, the second lands the readout.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 6, y, buttons: 0, pointerType: 'mouse' })
  await wait(120)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' })
  await wait(400)
  // Say out loud whether the hover layer actually opened, so a silent miss
  // cannot be mistaken for "the tooltip looks fine".
  const open = await cdp.evaluate('document.querySelectorAll(".viz-tooltip").length')
  console.log(open ? '  hover layer: tooltip open' : '  hover layer: NO tooltip — check the coordinates')
}

await cdp.screenshot(out)
console.log(`wrote ${out}${hover ? ` (hover ${hover})` : ''}`)
cdp.close()
process.exit(0)
