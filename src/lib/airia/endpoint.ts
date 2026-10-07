/**
 * Which Airia environment a key belongs to.
 *
 * A key is scoped to one tenant in ONE environment — the shared prodaus
 * cloud, or a cloud-prem customer's own — so the key and the host travel
 * together everywhere as a `Connection`. The page still calls `/airia/...`
 * on its own origin; the host rides in `x-airia-host` and the local proxy
 * (`proxy.mjs`) checks it against its allowlist and forwards there.
 *
 * People know an environment by the address they log in at,
 * `https://example.airia.ai`, while the API lives at
 * `example.api.airia.ai`. `apiHost()` accepts either, with or without a
 * scheme or path, so pasting the browser's address bar just works.
 */

export interface Connection {
  key: string
  /** The API host, e.g. `prodaus.api.airia.ai`. Never a URL. */
  host: string
}

export const DEFAULT_HOST = 'prodaus.api.airia.ai'

/** Environments offered without typing. Anything else under airia.ai can
 *  be typed; the proxy decides what it will forward to. */
export const KNOWN_ENVIRONMENTS: readonly { label: string; host: string }[] = [
  { label: 'prodaus (Airia cloud, AU)', host: DEFAULT_HOST },
]

/**
 * The API host for whatever was typed, or null if it cannot be one.
 *
 *   prodaus                     → prodaus.api.airia.ai
 *   https://example.airia.ai/   → example.api.airia.ai
 *   example.api.airia.ai        → example.api.airia.ai
 *
 * A host outside airia.ai is passed through unchanged: the proxy refuses it
 * unless `AIRIA_EXTRA_HOSTS` names it, and says so.
 */
export function apiHost(input: string): string | null {
  let s = input.trim().toLowerCase()
  if (s === '') return null
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '')
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(s) || s.includes('..')) return null
  if (!s.includes('.')) return `${s}.api.airia.ai`
  if (s.endsWith('.api.airia.ai')) return s
  if (s.endsWith('.airia.ai')) return s.replace(/\.airia\.ai$/, '.api.airia.ai')
  return s
}

/** A short name for an environment: `example` for `example.api.airia.ai`. */
export const envName = (host: string): string => host.replace(/\.api\.airia\.ai$/, '')

/** The headers every Airia request carries. */
export const airiaHeaders = (conn: Connection): Record<string, string> => ({
  'x-api-key': conn.key,
  'x-airia-host': conn.host,
  accept: 'application/json',
})
