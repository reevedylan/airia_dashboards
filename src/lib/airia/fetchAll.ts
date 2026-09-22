import type { RawRow } from './aggregate'

/**
 * Fetches AIOperationExecutions through the page's own origin.
 *
 * The Airia API sends no Access-Control-Allow-Origin header, so the browser
 * cannot call it directly whatever key you hold — the request goes to
 * `/airia/...` on this origin and a proxy (Vite in dev, `server.mjs` in
 * production) forwards it. The key travels in the request header only; it is
 * never put in a URL, where it would land in logs and history.
 */

const BASE = '/airia/api/marketplace/v1/AIOperationExecutions'
const PAGE_LIMIT = 200_000       // a ceiling, not the real bound
const MIN_WINDOW_MS = 1000       // bisection floor
const CHUNK_MS = 24 * 3_600_000
const CONCURRENCY = 6            // gentler than the CLI's 8; a browser shares the tab
const REQ_TIMEOUT_MS = 120_000

export class WindowTooLarge extends Error {}
export class AuthError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function requestWindow(key: string, start: number, end: number, signal?: AbortSignal): Promise<RawRow[]> {
  const url = `${BASE}?startTime=${start}&endTime=${end}&limit=${PAGE_LIMIT}&offset=0&descending=false`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'x-api-key': key, accept: 'application/json' } })

    if (res.status === 401 || res.status === 403) throw new AuthError(`The key was rejected (HTTP ${res.status}).`)

    // A 404 with an empty body is not "not found" — it is "response too big to
    // build". Retrying the same window is pointless; it has to be split.
    if (res.status === 404) {
      const body = await res.text()
      if (body.trim() === '') throw new WindowTooLarge('404 empty body')
      throw new Error(`404 with body: ${body.slice(0, 200)}`)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const json = await res.json()
    const items: RawRow[] = json.items ?? []
    // Can also return 200 with fewer items than totalCount — a silent partial
    // result. Checking the status code alone is not enough.
    if (items.length < (json.totalCount ?? 0)) {
      throw new WindowTooLarge(`partial: ${items.length} of ${json.totalCount}`)
    }
    return items
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      if (signal?.aborted) throw err
      throw new WindowTooLarge('timeout')
    }
    // A CORS or network failure surfaces as an opaque TypeError.
    if (err instanceof TypeError) {
      throw new Error('Could not reach the API through this origin. Is the proxy running?')
    }
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Retry genuine transient failures; never retry a "too large" window. */
async function withRetry(key: string, start: number, end: number, signal?: AbortSignal, attempts = 3): Promise<RawRow[]> {
  for (let i = 1; ; i++) {
    try {
      return await requestWindow(key, start, end, signal)
    } catch (err) {
      if (err instanceof WindowTooLarge || err instanceof AuthError || i >= attempts) throw err
      await sleep(i * 750)
    }
  }
}

export interface Progress {
  done: number
  total: number
  rows: number
  splits: number
}

/** Probe for the row count without transferring rows. Doubles as key validation. */
export async function probe(key: string, from: number, to: number): Promise<number> {
  const res = await fetch(`${BASE}?startTime=${from}&endTime=${to}&limit=1&offset=0`, {
    headers: { 'x-api-key': key, accept: 'application/json' },
  }).catch(() => { throw new Error('Could not reach the API through this origin. Is the proxy running?') })
  if (res.status === 401 || res.status === 403) throw new AuthError(`The key was rejected (HTTP ${res.status}).`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()).totalCount ?? 0
}

export async function fetchAll(
  key: string,
  from: number,
  to: number,
  onProgress?: (p: Progress) => void,
  signal?: AbortSignal,
): Promise<{ rows: RawRow[]; splits: number }> {
  const windows: Array<[number, number]> = []
  for (let s = from; s < to; s += CHUNK_MS) windows.push([s, Math.min(s + CHUNK_MS, to)])

  let splits = 0
  let done = 0
  let rowCount = 0
  const report = () => onProgress?.({ done, total: windows.length, rows: rowCount, splits })

  /** Fetch a window, bisecting recursively if the server cannot serve it whole. */
  const fetchWindow = async (start: number, end: number): Promise<RawRow[]> => {
    try {
      return await withRetry(key, start, end, signal)
    } catch (err) {
      if (!(err instanceof WindowTooLarge)) throw err
      if (end - start <= MIN_WINDOW_MS) {
        throw new Error(
          `Window ${start}-${end} still too large at the ${MIN_WINDOW_MS}ms floor (${err.message}). ` +
          'That is a real problem, not a size issue.',
        )
      }
      const mid = start + Math.floor((end - start) / 2)
      splits += 1
      report()
      const [a, b] = await Promise.all([fetchWindow(start, mid), fetchWindow(mid, end)])
      return a.concat(b)
    }
  }

  const out: RawRow[][] = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, windows.length) }, async () => {
      while (next < windows.length) {
        const i = next++
        out[i] = await fetchWindow(windows[i][0], windows[i][1])
        done += 1
        rowCount += out[i].length
        report()
      }
    }),
  )

  return { rows: out.flat(), splits }
}
