#!/usr/bin/env node
/**
 * Fetch Airia AIOperationExecutions and aggregate them into the exact bars
 * each dashboard range shows.
 *
 *   node scripts/ingest-airia.mjs
 *   node scripts/ingest-airia.mjs --source all
 *
 * Reads AIRIA_API_KEY from the environment or from a local .env. The key is
 * never written to disk or into the output.
 *
 * WHY THIS ISN'T IN THE BROWSER: the key would ship to every visitor, and the
 * endpoint silently truncates large windows (see fetchWindow) which needs
 * recursive bisection over tens of thousands of rows.
 *
 * Each range gets a fixed bucket size and a fixed bar count, so the output is
 * 414 buckets in total rather than 25,921 five-minute ones the client would
 * have to downsample. The bar count is then deterministic instead of a
 * function of how wide the card happens to be.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ------------------------------------------------------------------ args -- */

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const flag = (name) => argv.includes(`--${name}`)

const BASE = 'https://prodaus.api.airia.ai/api/marketplace/v1/AIOperationExecutions'
const SOURCE = arg('source', 'Gateway')          // 'Gateway' | 'all'
const OUT = resolve(ROOT, arg('out', 'public/data/airia-gateway.json'))
const CACHE_DIR = resolve(ROOT, '.cache/airia')
const CONCURRENCY = Number(arg('workers', 8))    // 8 was the observed sweet spot
const CHUNK_MS = Number(arg('chunk', 24)) * 3_600_000
const PAGE_LIMIT = 200_000                       // a ceiling, not the real bound
const MIN_WINDOW_MS = 1000                       // bisection floor
const REQ_TIMEOUT_MS = 120_000

/**
 * Bucket size and bar count per range. Window length is count x bucketMs, so
 * these also define what each range covers.
 */
const RANGE_SPECS = {
  '24H': { bucketMs: 15 * 60_000, count: 96 },
  '7D': { bucketMs: 2 * 3_600_000, count: 84 },
  '14D': { bucketMs: 4 * 3_600_000, count: 84 },
  '1M': { bucketMs: 12 * 3_600_000, count: 60 },
  '3M': { bucketMs: 24 * 3_600_000, count: 90 },
}

/**
 * Buckets are aligned to LOCAL time, not UTC. The 12-hour buckets have to fall
 * on midnight and noon Sydney time to read as AM/PM, and daily buckets on
 * local midnight — UTC alignment would put them at 10am/10pm and split every
 * Australian day in half.
 */
const ZONE = arg('zone', 'Australia/Sydney')

const now = arg('now') ? Date.parse(arg('now')) : Date.now()

/* ------------------------------------------------------------------- key -- */

function loadKey() {
  if (process.env.AIRIA_API_KEY) return process.env.AIRIA_API_KEY
  const envPath = resolve(ROOT, '.env')
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*AIRIA_API_KEY\s*=\s*(.*?)\s*$/)
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  }
  console.error('AIRIA_API_KEY not found in the environment or ./.env')
  process.exit(1)
}
const API_KEY = loadKey()

/* --------------------------------------------------------------- decimal -- */

/**
 * The API returns money as strings with up to 11 decimal places. Accumulating
 * those as floats drifts over 10^5 rows, so everything is summed as integers
 * scaled by 10^12 and converted back once, at the end.
 */
const SCALE = 12
const toScaled = (v) => {
  const s = String(v ?? '0').trim()
  if (s === '' || s === 'null') return 0n
  const neg = s.startsWith('-')
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.')
  const n = BigInt((i || '0') + f.padEnd(SCALE, '0').slice(0, SCALE))
  return neg ? -n : n
}
// 9dp is far finer than any real charge and keeps the JSON compact.
const fromScaled = (b) => Number((Number(b) / 10 ** SCALE).toFixed(9))

/* -------------------------------------------------------------- timezone -- */

const offsetCache = new Map()

/** Milliseconds ZONE is ahead of UTC at instant `t`. */
function zoneOffsetMs(t) {
  const key = Math.floor(t / 3_600_000)
  const hit = offsetCache.get(key)
  if (hit !== undefined) return hit
  const parts = {}
  for (const p of LOCAL_FMT.formatToParts(new Date(t))) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  const asUTC = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second,
  )
  const off = asUTC - Math.floor(t / 1000) * 1000
  offsetCache.set(key, off)
  return off
}

const LOCAL_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

/**
 * Floor `t` to a bucket boundary in local time.
 *
 * Two passes: the offset is first taken at `t`, then re-taken at the candidate
 * boundary. On a daylight-saving night those differ, and a single pass lands
 * an hour off local midnight.
 */
function localFloor(t, size) {
  const o1 = zoneOffsetMs(t)
  let b = Math.floor((t + o1) / size) * size - o1
  const o2 = zoneOffsetMs(b)
  if (o2 !== o1) b = Math.floor((t + o2) / size) * size - o2
  return b
}

/** The `count` bucket starts ending with the one containing `at`, ascending. */
function buildBoundaries(bucketMs, count, at) {
  const out = [localFloor(at, bucketMs)]
  while (out.length < count) out.unshift(localFloor(out[0] - 1, bucketMs))
  return out
}

/* ------------------------------------------------------------ http fetch -- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class WindowTooLarge extends Error {}

async function requestWindow(start, end) {
  const url = `${BASE}?startTime=${start}&endTime=${end}&limit=${PAGE_LIMIT}&offset=0&descending=false`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'x-api-key': API_KEY,
        accept: 'application/json, text/plain, */*',
        'accept-encoding': 'gzip, deflate',
      },
    })
    // A 404 with an empty body is not "not found" — it's "response too big
    // to build". Retrying the same window is pointless; it must be split.
    if (res.status === 404) {
      const body = await res.text()
      if (body.trim() === '') throw new WindowTooLarge('404 empty body')
      throw new Error(`404 with body: ${body.slice(0, 200)}`)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const json = await res.json()
    const items = json.items ?? []
    // Can also return 200 with fewer items than totalCount — a silent partial
    // result. Checking the status code alone is not enough.
    if (items.length < (json.totalCount ?? 0)) {
      throw new WindowTooLarge(`partial: ${items.length} of ${json.totalCount}`)
    }
    return { items, totalCount: json.totalCount ?? items.length }
  } catch (err) {
    if (err.name === 'AbortError') throw new WindowTooLarge('timeout')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** Retry genuine transient failures; never retry a "too large" window. */
async function requestWithRetry(start, end, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await requestWindow(start, end)
    } catch (err) {
      if (err instanceof WindowTooLarge || i >= attempts) throw err
      await sleep(i * 750)
    }
  }
}

let splitCount = 0

/** Fetch a window, bisecting recursively if the server can't serve it whole. */
async function fetchWindow(start, end, depth = 0) {
  try {
    const { items } = await requestWithRetry(start, end)
    return items
  } catch (err) {
    if (!(err instanceof WindowTooLarge)) throw err
    if (end - start <= MIN_WINDOW_MS) {
      throw new Error(
        `Window ${start}-${end} still too large at the ${MIN_WINDOW_MS}ms floor ` +
        `(${err.message}). That's a real problem, not a size issue.`,
      )
    }
    const mid = start + Math.floor((end - start) / 2)
    splitCount++
    process.stderr.write(`  split ${new Date(start).toISOString()} (${err.message})\n`)
    const [a, b] = await Promise.all([
      fetchWindow(start, mid, depth + 1),
      fetchWindow(mid, end, depth + 1),
    ])
    return a.concat(b)
  }
}

/** Run tasks with a bounded worker pool. */
async function pool(tasks, size) {
  const out = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++
        out[i] = await tasks[i]()
      }
    }),
  )
  return out
}

/* ------------------------------------------------------------ normalise -- */

const warnings = new Set()
const otherChargeKeys = new Set()

/**
 * Providers disagree about what `input` means, so normalise to three disjoint
 * buckets before anything is summed.
 *
 *   Anthropic: total = input + cached + output   (input EXCLUDES cached)
 *   OpenAI:    total = input + output            (input INCLUDES cached)
 *
 * Detected per row from the arithmetic rather than hardcoded by provider
 * name, so a new provider is handled without a code change. Stacking raw
 * `input` + `cached` would double-count cached tokens on OpenAI rows.
 */
function normaliseTokens(row) {
  const input = row.inputTokenCountConsumed ?? 0
  const cached = row.cachedInputTokenCountConsumed ?? 0
  const output = row.outputTokenCountConsumed ?? 0
  const total = row.totalTokenCountConsumed ?? 0

  if (input + cached + output === total) return { input, cached, output }
  if (input + output === total) return { input: Math.max(0, input - cached), cached, output }

  warnings.add(`token counts do not reconcile for provider ${row.providerType} (model ${row.modelName})`)
  return { input, cached, output }
}

/** Write-cache charges live under provider-specific keys that change over
 *  time (5-minute and 1-hour variants already exist), so match by shape. */
function splitCharges(additionalCharges) {
  let write = 0n
  let other = 0n
  for (const [key, value] of Object.entries(additionalCharges ?? {})) {
    if (/writecache/i.test(key)) write += toScaled(value)
    else { other += toScaled(value); otherChargeKeys.add(key) }
  }
  return { write, other }
}

/* ------------------------------------------------------------- aggregate -- */

const emptyBucket = () => ({
  tokIn: 0, tokCached: 0, tokOut: 0,
  amtIn: 0n, amtCached: 0n, amtOut: 0n, amtWrite: 0n, amtOther: 0n,
  executions: 0,
})
const emptyModel = () => ({
  inT: 0, caT: 0, ouT: 0,
  inC: 0n, caC: 0n, ouC: 0n, wrC: 0n, otC: 0n,
  executions: 0,
})
const MODEL_KEY_SEP = '\u0000'

function aggregate(rows) {
  // One bucket map and one model map per range.
  const ranges = Object.fromEntries(Object.entries(RANGE_SPECS).map(([key, spec]) => {
    const boundaries = buildBoundaries(spec.bucketMs, spec.count, now)
    return [key, {
      spec,
      boundaries,
      index: new Map(boundaries.map((b, i) => [b, i])),
      buckets: new Map(boundaries.map((b) => [b, emptyBucket()])),
      // Keyed by model + bucket index: isolating a model in the UI needs its
      // own per-category bars, not just a range total.
      modelBuckets: new Map(),
      modelNames: new Set(),
    }]
  }))

  const providers = {}
  let reconciled = 0
  let mismatched = 0
  let placed = 0

  for (const row of rows) {
    const t = Date.parse(row.executionDateTime)   // V8 handles the 7-digit fraction
    if (!Number.isFinite(t)) { warnings.add('unparseable executionDateTime skipped'); continue }

    const tok = normaliseTokens(row)
    const { write, other } = splitCharges(row.additionalCharges)
    const amtIn = toScaled(row.inputTokenAmountConsumed)
    const amtCached = toScaled(row.cachedInputTokenAmountConsumed)
    const amtOut = toScaled(row.outputTokenAmountConsumed)

    // Verify the money adds up, per row. This is the contract the whole
    // dashboard rests on, so it is checked rather than assumed.
    if (amtIn + amtCached + amtOut + write + other === toScaled(row.totalTokenAmountConsumed)) reconciled++
    else mismatched++

    providers[row.providerType ?? '(unknown)'] = (providers[row.providerType ?? '(unknown)'] ?? 0) + 1
    const name = row.modelName || '(unspecified)'
    let counted = false

    for (const r of Object.values(ranges)) {
      const bucketStart = localFloor(t, r.spec.bucketMs)
      const b = r.buckets.get(bucketStart)
      if (!b) continue                            // older than this range's window
      counted = true
      b.tokIn += tok.input; b.tokCached += tok.cached; b.tokOut += tok.output
      b.amtIn += amtIn; b.amtCached += amtCached; b.amtOut += amtOut
      b.amtWrite += write; b.amtOther += other
      b.executions++

      r.modelNames.add(name)
      const mk = `${name}${MODEL_KEY_SEP}${r.index.get(bucketStart)}`
      let m = r.modelBuckets.get(mk)
      if (!m) { m = emptyModel(); r.modelBuckets.set(mk, m) }
      m.inT += tok.input; m.caT += tok.cached; m.ouT += tok.output
      m.inC += amtIn; m.caC += amtCached; m.ouC += amtOut
      m.wrC += write; m.otC += other
      m.executions++
    }
    if (counted) placed++
  }

  const out = {}
  for (const [key, r] of Object.entries(ranges)) {
    const at = (b) => r.buckets.get(b)
    const col = (fn) => r.boundaries.map((b) => fn(at(b)))
    out[key] = {
      bucketMs: r.spec.bucketMs,
      bucketCount: r.spec.count,
      zone: ZONE,
      // Emitted rather than derived: locally-aligned buckets are not a strict
      // arithmetic grid across a daylight-saving change.
      x: r.boundaries,
      tokens: {
        input: col((b) => b.tokIn),
        cached: col((b) => b.tokCached),
        output: col((b) => b.tokOut),
      },
      cost: {
        input: col((b) => fromScaled(b.amtIn)),
        cached: col((b) => fromScaled(b.amtCached)),
        output: col((b) => fromScaled(b.amtOut)),
        write: col((b) => fromScaled(b.amtWrite)),
        // Non-token charges (web search requests, and whatever Airia adds
        // next), kept separate so the stacked chart sums to the true total.
        other: col((b) => fromScaled(b.amtOther)),
      },
      executions: col((b) => b.executions),
      /**
       * Per-model series, SPARSE: `h` holds the bucket indices where the model
       * ran and every other array is parallel to it. Categories stay split so
       * the UI can isolate one model and still stack it the same way, and so
       * the rate card divides like with like.
       *
       * Sparse because most model/bucket pairs are empty — dense would be
       * models x buckets x 9 arrays of mostly zeros.
       */
      models: [...r.modelNames]
        .map((model) => {
          const h = [], ex = []
          const tIn = [], tCa = [], tOu = []
          const cIn = [], cCa = [], cOu = [], cWr = [], cOt = []
          for (let i = 0; i < r.spec.count; i++) {
            const m = r.modelBuckets.get(`${model}${MODEL_KEY_SEP}${i}`)
            if (!m) continue
            h.push(i); ex.push(m.executions)
            tIn.push(m.inT); tCa.push(m.caT); tOu.push(m.ouT)
            cIn.push(fromScaled(m.inC)); cCa.push(fromScaled(m.caC)); cOu.push(fromScaled(m.ouC))
            cWr.push(fromScaled(m.wrC)); cOt.push(fromScaled(m.otC))
          }
          return { model, h, ex, tIn, tCa, tOu, cIn, cCa, cOu, cWr, cOt }
        })
        .filter((m) => m.h.length > 0)
        .sort((a, b) => {
          const spend = (x) => x.cIn.concat(x.cCa, x.cOu, x.cWr, x.cOt).reduce((p, c) => p + c, 0)
          return spend(b) - spend(a)
        }),
    }
  }

  return { ranges: out, stats: { providers, reconciled, mismatched, placed } }
}

/* ------------------------------------------------------------------ main -- */

const started = Date.now()

// Fetch far enough back to fill the longest range, from its first boundary.
const earliest = Math.min(...Object.values(RANGE_SPECS)
  .map((s) => buildBoundaries(s.bucketMs, s.count, now)[0]))
const from = earliest
const to = now

console.log(`Airia ingest — ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`)
console.log(`  source=${SOURCE}  zone=${ZONE}  workers=${CONCURRENCY}  chunk=${CHUNK_MS / 3_600_000}h`)
for (const [k, s] of Object.entries(RANGE_SPECS)) {
  console.log(`    ${k.padEnd(4)} ${String(s.count).padStart(3)} bars x ${(s.bucketMs / 60_000).toString().padStart(4)} min`)
}

const probeUrl = `${BASE}?startTime=${from}&endTime=${to}&limit=1&offset=0`
const probe = await fetch(probeUrl, {
  headers: { 'x-api-key': API_KEY, accept: 'application/json' },
}).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`probe HTTP ${r.status}`))))
console.log(`  expected totalCount across range: ${probe.totalCount.toLocaleString()}`)

const windows = []
for (let s = from; s < to; s += CHUNK_MS) windows.push([s, Math.min(s + CHUNK_MS, to)])
console.log(`  ${windows.length} windows`)

const chunks = await pool(windows.map(([s, e]) => () => fetchWindow(s, e)), CONCURRENCY)
const all = chunks.flat()

console.log(`  fetched ${all.length.toLocaleString()} rows (${splitCount} window splits)`)
if (all.length < probe.totalCount) {
  console.log(`  NOTE: fetched ${all.length} vs probe ${probe.totalCount} — investigate a large shortfall.`)
}

const scoped = SOURCE === 'all' ? all : all.filter((r) => r.executionSourceType === SOURCE)
console.log(`  ${scoped.length.toLocaleString()} rows after source filter (${SOURCE})`)

const agg = aggregate(scoped)

// Cache only the fields aggregation needs — deliberately dropping userEmail,
// names and tenantId so even the gitignored cache holds no personal data.
mkdirSync(CACHE_DIR, { recursive: true })
const KEEP = [
  'executionDateTime', 'executionSourceType', 'providerType', 'modelName',
  'inputTokenCountConsumed', 'cachedInputTokenCountConsumed', 'outputTokenCountConsumed',
  'totalTokenCountConsumed', 'inputTokenAmountConsumed', 'cachedInputTokenAmountConsumed',
  'outputTokenAmountConsumed', 'totalTokenAmountConsumed', 'balanceUsed', 'additionalCharges',
]
writeFileSync(
  resolve(CACHE_DIR, `rows-${from}-${to}.ndjson`),
  scoped.map((r) => JSON.stringify(Object.fromEntries(KEEP.map((k) => [k, r[k]])))).join('\n') + '\n',
)

const out = {
  meta: {
    generatedAt: new Date().toISOString(),
    now, from, to,
    source: SOURCE,
    zone: ZONE,
    rowCount: scoped.length,
    rowsPlaced: agg.stats.placed,
    rangeTotalCount: probe.totalCount,
    windowSplits: splitCount,
    providers: agg.stats.providers,
    otherChargeKeys: [...otherChargeKeys],
    amountsReconciled: agg.stats.reconciled,
    amountsMismatched: agg.stats.mismatched,
    warnings: [...warnings],
  },
  ranges: agg.ranges,
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(out))

const sum = (a) => a.reduce((p, c) => p + c, 0)
console.log(`\n  amounts reconciled: ${agg.stats.reconciled.toLocaleString()} / mismatched: ${agg.stats.mismatched}`)
for (const [k, r] of Object.entries(agg.ranges)) {
  const cost = sum(r.cost.input) + sum(r.cost.cached) + sum(r.cost.output) + sum(r.cost.write) + sum(r.cost.other)
  const tok = sum(r.tokens.input) + sum(r.tokens.cached) + sum(r.tokens.output)
  const live = r.executions.filter((n) => n > 0).length
  console.log(`  ${k.padEnd(4)} $${cost.toFixed(2).padStart(9)}  ${tok.toLocaleString().padStart(15)} tokens  ` +
    `${String(live).padStart(3)}/${r.bucketCount} bars with activity  ${r.models.length} models`)
}
if (otherChargeKeys.size) console.log(`\n  other charge keys: ${[...otherChargeKeys].join(', ')}`)
if (warnings.size) { console.log('\n  warnings:'); for (const w of warnings) console.log(`    - ${w}`) }
console.log(`\n  wrote ${OUT.replace(ROOT + '/', '')} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
if (flag('verbose')) {
  for (const [k, r] of Object.entries(agg.ranges)) {
    console.log(`\n${k} first/last bar (${ZONE}):`)
    const f = new Intl.DateTimeFormat('en-AU', { timeZone: ZONE, dateStyle: 'medium', timeStyle: 'short' })
    console.log('  ', f.format(new Date(r.x[0])), '->', f.format(new Date(r.x[r.x.length - 1])))
  }
}
