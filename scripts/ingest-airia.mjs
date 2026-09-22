#!/usr/bin/env node
/**
 * Fetch Airia AIOperationExecutions and aggregate them into the shape the
 * charts consume.
 *
 *   node scripts/ingest-airia.mjs                      # last 90 days, Gateway
 *   node scripts/ingest-airia.mjs --from 2026-09-01 --to 2026-09-22
 *   node scripts/ingest-airia.mjs --days 7 --bucket 1
 *   node scripts/ingest-airia.mjs --source all
 *
 * Reads AIRIA_API_KEY from the environment or from a local .env. The key is
 * never written to disk or into the output.
 *
 * WHY THIS ISN'T IN THE BROWSER: the key would ship to every visitor, and the
 * endpoint silently truncates large windows (see fetchWindow) which needs
 * recursive bisection and hundreds of thousands of rows. The app reads only
 * the bucketed output.
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
const BUCKET_MIN = Number(arg('bucket', 5))
const BUCKET_MS = BUCKET_MIN * 60_000
// Served as a static asset (not imported) so 600KB of aggregates stays out of
// the JS bundle. Gitignored: these are aggregates rather than PII, but they
// still disclose tenant spend and this repo is public.
const OUT = resolve(ROOT, arg('out', 'public/data/airia-gateway.json'))
const CACHE_DIR = resolve(ROOT, '.cache/airia')
const CONCURRENCY = Number(arg('workers', 8))    // 8 was the observed sweet spot
const CHUNK_MS = Number(arg('chunk', 24)) * 3_600_000
const PAGE_LIMIT = 200_000                       // a ceiling, not the real bound
const MIN_WINDOW_MS = 1000                       // bisection floor
const REQ_TIMEOUT_MS = 120_000

const to = arg('to') ? Date.parse(arg('to')) : Date.now()
const from = arg('from')
  ? Date.parse(arg('from'))
  : to - Number(arg('days', 90)) * 86_400_000

if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
  console.error('Bad --from/--to range')
  process.exit(1)
}

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
export const toScaled = (v) => {
  const s = String(v ?? '0').trim()
  if (s === '' || s === 'null') return 0n
  const neg = s.startsWith('-')
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.')
  const n = BigInt((i || '0') + f.padEnd(SCALE, '0').slice(0, SCALE))
  return neg ? -n : n
}
// 9dp is far finer than any real charge and keeps the JSON compact.
const fromScaled = (b) => Number((Number(b) / 10 ** SCALE).toFixed(9))

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

function aggregate(rows) {
  const buckets = new Map()
  const models = new Map()
  // Per-model series at hourly resolution. The models table only ever needs
  // range TOTALS, so an hour is ample — and it keeps the payload at ~4 models
  // x 2,160 hours rather than x 25,921 five-minute buckets.
  const HOUR_MS = 3_600_000
  const modelHours = new Map()
  const providers = {}
  let reconciledAmounts = 0
  let mismatchedAmounts = 0

  for (const row of rows) {
    const t = Date.parse(row.executionDateTime)   // V8 handles the 7-digit fraction
    if (!Number.isFinite(t)) { warnings.add('unparseable executionDateTime skipped'); continue }

    const key = Math.floor(t / BUCKET_MS) * BUCKET_MS
    let b = buckets.get(key)
    if (!b) {
      b = {
        tokIn: 0, tokCached: 0, tokOut: 0,
        amtIn: 0n, amtCached: 0n, amtOut: 0n, amtWrite: 0n, amtOther: 0n,
        balance: 0n, executions: 0,
      }
      buckets.set(key, b)
    }

    const tok = normaliseTokens(row)
    const { write, other } = splitCharges(row.additionalCharges)

    const amtIn = toScaled(row.inputTokenAmountConsumed)
    const amtCached = toScaled(row.cachedInputTokenAmountConsumed)
    const amtOut = toScaled(row.outputTokenAmountConsumed)

    // Verify the money adds up, per row. This is the contract the whole
    // dashboard rests on, so it is checked rather than assumed.
    if (amtIn + amtCached + amtOut + write + other === toScaled(row.totalTokenAmountConsumed)) reconciledAmounts++
    else mismatchedAmounts++

    b.tokIn += tok.input; b.tokCached += tok.cached; b.tokOut += tok.output
    b.amtIn += amtIn; b.amtCached += amtCached; b.amtOut += amtOut
    b.amtWrite += write; b.amtOther += other
    b.balance += toScaled(row.balanceUsed)
    b.executions++

    providers[row.providerType ?? '(unknown)'] = (providers[row.providerType ?? '(unknown)'] ?? 0) + 1

    const name = row.modelName || '(unspecified)'
    let m = models.get(name)
    if (!m) { m = { model: name, cost: 0n, executions: 0 }; models.set(name, m) }
    const rowCost = amtIn + amtCached + amtOut + write + other
    m.cost += rowCost
    m.executions++

    // Keep counts and costs split per category. A blended $/M rate ranks
    // models by how often they hit cache rather than by price — haiku is 5x
    // cheaper per token than opus but blends higher, because opus caches more.
    // The rate card (cost/count per category) is the model's actual price.
    const hourKey = `${name}\u0000${Math.floor(t / HOUR_MS) * HOUR_MS}`
    let mh = modelHours.get(hourKey)
    if (!mh) {
      mh = { inT: 0, caT: 0, ouT: 0, inC: 0n, caC: 0n, ouC: 0n, wrC: 0n, otC: 0n, executions: 0 }
      modelHours.set(hourKey, mh)
    }
    mh.inT += tok.input; mh.caT += tok.cached; mh.ouT += tok.output
    mh.inC += amtIn; mh.caC += amtCached; mh.ouC += amtOut
    mh.wrC += write; mh.otC += other
    mh.executions++
  }

  /**
   * Emit a DENSE grid: one entry per bucket across the whole range, including
   * the empty ones. Only writing buckets that contain rows produces an
   * unevenly-spaced series, and the charts assume index i maps to a fixed
   * time step — a 62-hour quiet spell would otherwise render as two adjacent
   * bars and misstate when the spend happened.
   *
   * The x axis is a strict arithmetic grid, so it is described by
   * (from0, bucketMs, bucketCount) rather than shipped as an array it could
   * drift out of sync with.
   */
  const from0 = Math.floor(from / BUCKET_MS) * BUCKET_MS
  const bucketCount = Math.max(1, Math.ceil((to - from0) / BUCKET_MS))
  const EMPTY = {
    tokIn: 0, tokCached: 0, tokOut: 0,
    amtIn: 0n, amtCached: 0n, amtOut: 0n, amtWrite: 0n, amtOther: 0n,
    balance: 0n, executions: 0,
  }
  const at = (i) => buckets.get(from0 + i * BUCKET_MS) ?? EMPTY
  const col = (fn) => Array.from({ length: bucketCount }, (_, i) => fn(at(i)))

  const hour0 = Math.floor(from / HOUR_MS) * HOUR_MS
  const hourCount = Math.max(1, Math.ceil((to - hour0) / HOUR_MS))
  const modelNames = [...models.values()].sort((a, b) => Number(b.cost - a.cost)).map((m) => m.model)

  // SPARSE: only hours where a model actually ran. Dense would be
  // models x hours x 9 metrics of mostly zeros; activity is under 10%.
  const perModelSparse = modelNames.map((name) => {
    const h = [], ex = []
    const inT = [], caT = [], ouT = [], inC = [], caC = [], ouC = [], wrC = [], otC = []
    for (let i = 0; i < hourCount; i++) {
      const mh = modelHours.get(`${name}\u0000${hour0 + i * HOUR_MS}`)
      if (!mh) continue
      h.push(i); ex.push(mh.executions)
      inT.push(mh.inT); caT.push(mh.caT); ouT.push(mh.ouT)
      inC.push(fromScaled(mh.inC)); caC.push(fromScaled(mh.caC)); ouC.push(fromScaled(mh.ouC))
      wrC.push(fromScaled(mh.wrC)); otC.push(fromScaled(mh.otC))
    }
    return { model: name, h, ex, inT, caT, ouT, inC, caC, ouC, wrC, otC }
  })


  return {
    from0, bucketCount,
    byModel: { hour0, hourCount, models: perModelSparse },
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
      // Non-token charges (web search requests, and whatever Airia adds next).
      // Emitted separately so the stacked cost chart still sums to the true
      // total instead of quietly dropping them.
      other: col((b) => fromScaled(b.amtOther)),
    },
    balanceUsed: col((b) => fromScaled(b.balance)),
    executions: col((b) => b.executions),

    stats: { providers, reconciledAmounts, mismatchedAmounts },
  }
}

/* ------------------------------------------------------------------ main -- */

const started = Date.now()
console.log(`Airia ingest — ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`)
console.log(`  source=${SOURCE}  bucket=${BUCKET_MIN}min  workers=${CONCURRENCY}  chunk=${CHUNK_MS / 3_600_000}h`)

// Probe first, so a silent truncation later can be caught by comparison.
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
if (all.length !== probe.totalCount) {
  console.log(`  NOTE: fetched ${all.length} vs probe ${probe.totalCount} — ` +
    `expected if rows landed while fetching; investigate a large shortfall.`)
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
    from, to, bucketMs: BUCKET_MS, source: SOURCE,
    // The x axis is a strict arithmetic grid, described rather than shipped:
    // x[i] === from0 + i * bucketMs. Keeps 25k timestamps out of the payload
    // and means x can never drift out of step with the value arrays.
    from0: agg.from0, bucketCount: agg.bucketCount,
    generatedAt: new Date().toISOString(),
    rowCount: scoped.length,
    rangeTotalCount: probe.totalCount,
    windowSplits: splitCount,
    providers: agg.stats.providers,
    otherChargeKeys: [...otherChargeKeys],
    amountsReconciled: agg.stats.reconciledAmounts,
    amountsMismatched: agg.stats.mismatchedAmounts,
    warnings: [...warnings],
  },
  tokens: agg.tokens,
  cost: agg.cost,
  balanceUsed: agg.balanceUsed,
  executions: agg.executions,
  byModel: agg.byModel,
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(out))

const sum = (a) => a.reduce((p, c) => p + c, 0)
const filled = agg.executions.filter((n) => n > 0).length
console.log(`\n  buckets: ${agg.bucketCount.toLocaleString()} dense (${filled.toLocaleString()} with activity, ${(filled / agg.bucketCount * 100).toFixed(1)}%)`)
console.log(`  amounts reconciled: ${agg.stats.reconciledAmounts.toLocaleString()} / mismatched: ${agg.stats.mismatchedAmounts}`)
console.log(`  tokens  in ${sum(agg.tokens.input).toLocaleString()} · cached ${sum(agg.tokens.cached).toLocaleString()} · out ${sum(agg.tokens.output).toLocaleString()}`)
const costTotal = sum(agg.cost.input) + sum(agg.cost.cached) + sum(agg.cost.output) + sum(agg.cost.write) + sum(agg.cost.other)
console.log(`  cost    $${costTotal.toFixed(4)}  (in $${sum(agg.cost.input).toFixed(4)} · cached $${sum(agg.cost.cached).toFixed(4)} · out $${sum(agg.cost.output).toFixed(4)} · write $${sum(agg.cost.write).toFixed(4)} · other $${sum(agg.cost.other).toFixed(4)})`)
if (otherChargeKeys.size) console.log(`  other charge keys: ${[...otherChargeKeys].join(', ')}`)
console.log(`  balance $${sum(agg.balanceUsed).toFixed(4)}`)
if (warnings.size) { console.log('\n  warnings:'); for (const w of warnings) console.log(`    - ${w}`) }
console.log(`\n  wrote ${OUT.replace(ROOT + '/', '')} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
if (flag('verbose')) console.log(JSON.stringify(out.byModel.models.map((m) => m.model), null, 2))
