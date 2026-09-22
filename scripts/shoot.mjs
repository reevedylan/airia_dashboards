#!/usr/bin/env node
/**
 * Screenshot the running dev server, optionally after moving the pointer —
 * so the hover layer (crosshair, tooltip, arc lift) can be eyeballed, not
 * assumed.
 *
 *   node scripts/shoot.mjs --out /tmp/a.png
 *   node scripts/shoot.mjs --out /tmp/b.png --hover 420,330
 *   node scripts/shoot.mjs --out /tmp/c.png --click 1490,93 --hover 600,330
 *
 * Needs Chrome already running with --remote-debugging-port=9222.
 */

import { writeFileSync } from 'node:fs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const url = arg('url', 'http://localhost:5173/')
const out = arg('out', '/tmp/shot.png')
const hover = arg('hover', null)
const click = arg('click', null)
/** Click by CSS selector — steadier than guessing pixel coordinates. */
const clickSel = arg('click-sel', null)
const width = Number(arg('width', 1600))
const height = Number(arg('height', 1000))
/* Keep this at 1 when using --hover: with a scale factor applied, CDP input
   coordinates no longer line up with CSS pixels. */
const dsf = Number(arg('dsf', 1))

const targets = await (await fetch('http://localhost:9222/json/list')).json()
let page = targets.find((t) => t.type === 'page')
if (!page) {
  page = await (await fetch(`http://localhost:9222/json/new?${encodeURIComponent(url)}`)).json()
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()

ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? {})
    pending.delete(msg.id)
  }
})

await new Promise((r) => ws.addEventListener('open', r))

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id
    pending.set(n, resolve)
    ws.send(JSON.stringify({ id: n, method, params }))
  })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile: false })
await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url })
await wait(1400)

// Several clicks: "x,y;x,y" — e.g. flip the theme, then change the range.
for (const step of (click ? click.split(';') : [])) {
  const [x, y] = step.split(',').map(Number)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
  }
  await wait(450)
}

for (const sel of (clickSel ? clickSel.split(';') : [])) {
  const res = await send('Runtime.evaluate', {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'; el.click(); return 'clicked' })()`,
    returnByValue: true,
  })
  console.log(`  click ${sel}: ${res.result?.value}`)
  await wait(450)
}

if (hover) {
  const [x, y] = hover.split(',').map(Number)
  // Two moves: the first settles pointerenter, the second lands the readout.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 6, y, buttons: 0, pointerType: 'mouse' })
  await wait(120)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' })
  await wait(400)

  // Say out loud whether the hover layer actually opened, so a silent miss
  // can't be mistaken for "the tooltip looks fine".
  const probe = await send('Runtime.evaluate', {
    expression: 'document.querySelectorAll(".viz-tooltip").length',
    returnByValue: true,
  })
  console.log(
    probe.result?.value
      ? '  hover layer: tooltip open'
      : '  hover layer: no tooltip (expected for the donut, which reports in its centre — otherwise check coords)',
  )
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log(`wrote ${out}${hover ? ` (hover ${hover})` : ''}`)
ws.close()
process.exit(0)
