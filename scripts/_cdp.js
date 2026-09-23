/**
 * Minimal Chrome DevTools Protocol client, shared by the check scripts.
 *
 * They all need the same four things — connect to a tab, run an expression
 * in the page, resize the viewport, take a screenshot — and each one having
 * its own copy of the socket plumbing is how they drift.
 *
 * Every script here needs Chrome already listening:
 *
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless --remote-debugging-port=9222 --user-data-dir=/tmp/viz-chrome about:blank &
 */

const PORT = process.env.CHROME_PORT ?? 9222

export const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms))

export async function connect() {
  const targets = await (await fetch(`http://localhost:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error(`No page target on :${PORT}. Is headless Chrome running?`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    else if (m.method && listeners.has(m.method)) listeners.get(m.method).forEach((f) => f(m.params))
  })
  const listeners = new Map()
  await new Promise((r) => ws.addEventListener('open', r))

  const send = (method, params = {}) =>
    new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) })

  /**
   * Run an expression in the page and return its value.
   *
   * Async expressions are awaited, and a throw comes back as
   * `{ ERROR }` rather than silently as undefined — a check that fails
   * quietly is worse than one that fails.
   */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) {
      return { ERROR: r.result.exceptionDetails.exception?.description ?? 'threw' }
    }
    return r.result?.result?.value
  }

  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, [])
    listeners.get(method).push(fn)
  }

  return {
    send, evaluate, on,
    resize: (width, height) =>
      send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
    /** Seeds the API key from the ENVIRONMENT, never a flag: an argument is
     *  visible in `ps` and lands in shell history. */
    seedKey: () => process.env.AIRIA_API_KEY
      ? send('Page.addScriptToEvaluateOnNewDocument', {
          source: `try { sessionStorage.setItem('airia-api-key', ${JSON.stringify(process.env.AIRIA_API_KEY)}) } catch {}`,
        })
      : Promise.resolve(),
    screenshot: async (path) => {
      // `send` resolves the whole protocol message, so the payload is one
      // level deeper than the CDP docs' examples suggest.
      const msg = await send('Page.captureScreenshot', { format: 'png' })
      const { writeFileSync } = await import('node:fs')
      writeFileSync(path, Buffer.from(msg.result.data, 'base64'))
    },
    close: () => ws.close(),
  }
}

/** Navigate with the key seeded, then wait for the dashboard. */
export async function seedAndOpen(cdp, url) {
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.seedKey()
  await cdp.send('Page.navigate', { url })
  return waitForDashboard(cdp)
}

/** Wait until the dashboard has data on screen and is not mid-fetch. */
export async function waitForDashboard(cdp, { timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => {
      const gate = document.querySelector('.gate')
      if (gate) return gate.hasAttribute('data-busy') ? 'first-load' : 'gate'
      if (!document.querySelector('.strip')) return 'blank'
      return document.querySelector('.page__busy') ? 'busy' : 'ready'
    })()`)
    if (state === 'ready') return 'ready'
    if (state === 'gate') return 'gate'
    await wait(400)
  }
  return 'timeout'
}

/** Settle after an interaction: let React commit, then wait out any fetch. */
export const SETTLE = `async () => {
  const s = (ms) => new Promise((r) => setTimeout(r, ms))
  await s(300)
  for (let i = 0; i < 240; i++) { if (!document.querySelector('.page__busy')) break; await s(250) }
  await s(400)
}`
