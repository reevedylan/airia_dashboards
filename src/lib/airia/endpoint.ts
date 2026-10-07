/**
 * Which Airia environment a key belongs to.
 *
 * A key is scoped to one tenant in ONE environment — the shared prodaus
 * cloud, or a cloud-prem customer's own — so the key and the host travel
 * together everywhere as a `Connection`. The page still calls `/airia/...`
 * on its own origin; the host rides in `x-airia-host` and the local proxy
 * (`proxy.mjs`) checks it against its allowlist and forwards there.
 *
 * The SaaS regions are a fixed list. A customer's own environment is
 * typed, and people know it by the address they log in at,
 * `https://example.airia.ai`, while the API lives at
 * `example.api.airia.ai`. `apiHost()` accepts either, with or without a
 * scheme or path, so pasting the browser's address bar just works.
 */

export interface Connection {
  key: string
  /** The API host, e.g. `prodaus.api.airia.ai`. Never a URL. */
  host: string
}

/**
 * Airia's SaaS regions. Every region's app is at `<code>.airia.ai` and its
 * API at `<code>.api.airia.ai` — except the US, which is the bare domain:
 * the app at `airia.ai`, the API at `api.airia.ai`. Anything else is a
 * customer's own environment, typed into Custom.
 */
export const REGIONS: readonly { label: string; flag: string; host: string }[] = [
  { label: 'US East', flag: '🇺🇸', host: 'api.airia.ai' },
  { label: 'Australia East', flag: '🇦🇺', host: 'prodaus.api.airia.ai' },
  { label: 'Canada Central', flag: '🇨🇦', host: 'ca01.api.airia.ai' },
  { label: 'Netherlands West', flag: '🇳🇱', host: 'eu1.api.airia.ai' },
  { label: 'Singapore', flag: '🇸🇬', host: 'sg01.api.airia.ai' },
  { label: 'UAE North', flag: '🇦🇪', host: 'mena.api.airia.ai' },
]

/** US East, Airia's own default region. */
export const DEFAULT_HOST = REGIONS[0].host

export const regionOf = (host: string) => REGIONS.find((r) => r.host === host) ?? null

/**
 * The API host for whatever was typed, or null if it cannot be one.
 *
 *   https://example.airia.ai/   → example.api.airia.ai
 *   example                     → example.api.airia.ai
 *   example.api.airia.ai        → example.api.airia.ai
 *   https://airia.ai            → api.airia.ai          (the US: no subdomain)
 *
 * A host outside airia.ai is passed through unchanged: the proxy refuses it
 * unless `AIRIA_EXTRA_HOSTS` names it, and says so.
 */
export function apiHost(input: string): string | null {
  let s = input.trim().toLowerCase()
  if (s === '') return null
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '')
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(s) || s.includes('..')) return null
  // The US first: `api.airia.ai` also ENDS in `.airia.ai`, and the rule
  // below would turn it into `api.api.airia.ai`.
  if (s === 'airia.ai' || s === 'www.airia.ai' || s === 'api.airia.ai') return 'api.airia.ai'
  if (!s.includes('.')) return `${s}.api.airia.ai`
  if (s.endsWith('.api.airia.ai')) return s
  if (s.endsWith('.airia.ai')) return s.replace(/\.airia\.ai$/, '.api.airia.ai')
  return s
}

/** A short name for an environment: the region's, or `example` for
 *  `example.api.airia.ai`. */
export const envName = (host: string): string =>
  regionOf(host)?.label ?? host.replace(/\.api\.airia\.ai$/, '')

/** The headers every Airia request carries. */
export const airiaHeaders = (conn: Connection): Record<string, string> => ({
  'x-api-key': conn.key,
  'x-airia-host': conn.host,
  accept: 'application/json',
})
