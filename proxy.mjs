/**
 * The one /airia proxy, shared by Vite (dev and preview) and `server.mjs`.
 *
 * The Airia API sends no Access-Control-Allow-Origin header, so the page
 * calls `/airia/...` on its own origin and this forwards it. Which Airia
 * environment it forwards to is chosen PER REQUEST, by the page, in the
 * `x-airia-host` header: one of Airia's SaaS regions, or a cloud-prem
 * customer's own `<name>.api.airia.ai`. One running copy serves any of them, so
 * switching environment is a choice on the key page rather than a restart.
 *
 * The host is checked against an allowlist before anything is sent. This
 * forwards the caller's API key, and a proxy that would forward it to any
 * host the page names is a key-exfiltration relay. Allowed: any
 * `*.airia.ai` host, plus whatever `AIRIA_EXTRA_HOSTS` lists (comma
 * separated) for a deployment on a customer's own domain.
 */

/** US East, the page's default region, for a request that names none. */
export const DEFAULT_HOST = 'api.airia.ai'

const EXTRA = new Set(
  (process.env.AIRIA_EXTRA_HOSTS ?? '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
)

/** A bare hostname under airia.ai — no scheme, port, path or userinfo. */
const AIRIA = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.airia\.ai$/

export function allowedHost(host) {
  const h = String(host ?? '').trim().toLowerCase()
  return AIRIA.test(h) || EXTRA.has(h) ? h : null
}

/** Only the headers the API needs are forwarded, and the key is never logged. */
function forwardHeaders(req) {
  const out = { accept: 'application/json' }
  const key = req.headers['x-api-key']
  if (typeof key === 'string' && key !== '') out['x-api-key'] = key
  return out
}

function fail(res, status, error) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error }))
}

/** Handles one `/airia/...` request. `req.url` still carries the prefix. */
export async function proxyAiria(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Only GET is proxied.')
  const asked = req.headers['x-airia-host']
  const host = asked == null ? DEFAULT_HOST : allowedHost(asked)
  if (!host) return fail(res, 400, `Not an Airia host: ${String(asked).slice(0, 100)}`)

  const target = `https://${host}${req.url.replace(/^\/airia/, '')}`
  try {
    const upstream = await fetch(target, { method: 'GET', headers: forwardHeaders(req) })
    const body = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch (err) {
    fail(res, 502, `Upstream request to ${host} failed: ${err.message}`)
  }
}
