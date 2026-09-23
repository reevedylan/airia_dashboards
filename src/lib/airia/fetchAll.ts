import { slim, type RawRow } from './aggregate'

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
const PAGE_LIMIT = 200_000       // the real bound: a response is capped here
const MIN_WINDOW_MS = 1000       // bisection floor

/**
 * How much time one request asks for.
 *
 * A day at a time was costing far more than it saved. Measured against a
 * live tenant: throughput is ~12k rows/s whatever the window, so the only
 * thing a small window adds is its own round trip — 184 of them to load six
 * months, which is most of the nine seconds that took. The same span in
 * 15-day chunks is a dozen requests.
 *
 * Fifteen rather than thirty: the server is not linear in window size, and
 * thirty-day chunks measured SLOWER overall despite halving the request
 * count. The ceiling is `PAGE_LIMIT` — a 365-day window came back with
 * exactly 200,000 of 320,825 rows — and fifteen days is that limit at
 * thirteen times this tenant's volume. Anything denser bisects, a path
 * since exercised for real against a deliberately oversized window.
 */
const CHUNK_MS = 15 * 24 * 3_600_000
const CONCURRENCY = 6            // gentler than the CLI's 8; a browser shares the tab
/**
 * Background work runs at the same width as foreground work now. It was
 * halved when a sweep meant hundreds of day-sized requests, which is what
 * tripped the API's rate limiter; a year of history is a couple of dozen
 * requests, and the limiter counts requests.
 */
export const BACKGROUND_CONCURRENCY = 6
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
    // Projected here, where rows enter, so nothing downstream ever holds a
    // field it does not read. Counts are untouched: every row survives.
    return items.map(slim)
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

/**
 * Retry genuine transient failures; never retry a "too large" window, a
 * rejected key, or work that has been CANCELLED.
 *
 * Cancellation used to fall through to the retry branch, so aborting a fetch
 * sat through two backoff sleeps before it gave up. That is what put a
 * two-second dead patch between changing the window and the page admitting
 * it was doing anything — and it re-sent requests nobody wanted any more.
 */
async function withRetry(key: string, start: number, end: number, signal?: AbortSignal, attempts = 3): Promise<RawRow[]> {
  for (let i = 1; ; i++) {
    try {
      return await requestWindow(key, start, end, signal)
    } catch (err) {
      if (err instanceof WindowTooLarge || err instanceof AuthError) throw err
      if (signal?.aborted || i >= attempts) throw err
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

export interface FetchOptions {
  onProgress?: (p: Progress) => void
  signal?: AbortSignal
  /**
   * Parallel windows in flight. The default is what a foreground load uses;
   * background backfill runs lower, because the API starts returning 403s
   * under sustained parallel load and a slow backfill nobody is waiting for
   * is better than a throttled one someone is.
   */
  concurrency?: number
  /** Span per request. Overridden only to exercise the bisection path. */
  chunkMs?: number
}

export async function fetchAll(
  key: string,
  from: number,
  to: number,
  { onProgress, signal, concurrency = CONCURRENCY, chunkMs = CHUNK_MS }: FetchOptions = {},
): Promise<{ rows: RawRow[]; splits: number }> {
  const windows: Array<[number, number]> = []
  for (let s = from; s < to; s += chunkMs) windows.push([s, Math.min(s + chunkMs, to)])

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
    Array.from({ length: Math.max(1, Math.min(concurrency, windows.length)) }, async () => {
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
