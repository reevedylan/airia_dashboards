import { NO_GATEWAY } from './aggregate'

/**
 * Names for gateway configurations.
 *
 * Executions carry only `gatewayConfigurationId`, a bare UUID, so the
 * breakdown and the filter would otherwise list rows of hex. The names come
 * from a separate endpoint, and everything here is built on the assumption
 * that the call MAY FAIL — it is a different resource from executions and
 * may well want a different key or scope, so a dashboard that only works
 * when it succeeds would be a dashboard that stops working for most keys.
 *
 * Failure is therefore not an error: it returns no names, every gateway
 * shows a short id instead, and nothing else on the page notices.
 */

/**
 * Where the names live. One line to change when the endpoint is confirmed —
 * along with `readNames` below if the payload is shaped differently.
 */
const NAMES_URL = '/airia/api/marketplace/v1/GatewayConfigurations?limit=500'

/** Gateway id → display name. */
export type GatewayNames = Readonly<Record<string, string>>

/**
 * Pull `{ id: name }` out of whatever the endpoint returns.
 *
 * Deliberately shape-tolerant: it accepts a bare array or the `items`
 * envelope the executions endpoint uses, and takes the first name-ish field
 * it finds. An unrecognised payload yields no names rather than junk ones.
 */
function readNames(payload: unknown): GatewayNames {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { items?: unknown[] })?.items)
      ? (payload as { items: unknown[] }).items
      : []
  const out: Record<string, string> = {}
  for (const row of list) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const id = r.id ?? r.gatewayConfigurationId ?? r.configurationId
    const name = r.name ?? r.displayName ?? r.gatewayName ?? r.title
    if (typeof id === 'string' && typeof name === 'string' && name.trim() !== '') {
      out[id] = name.trim()
    }
  }
  return out
}

export async function fetchGatewayNames(key: string, signal?: AbortSignal): Promise<GatewayNames> {
  try {
    const res = await fetch(NAMES_URL, {
      signal,
      headers: { 'x-api-key': key, accept: 'application/json' },
    })
    // 401/403 is the expected answer for a key without the scope, and is
    // not worth surfacing: ids are a usable fallback.
    if (!res.ok) return {}
    return readNames(await res.json())
  } catch {
    return {}
  }
}

/**
 * What to show for a gateway.
 *
 * A short id rather than the full UUID when there is no name: 36 characters
 * of hex in a filter list is unreadable, and the first block is enough to
 * tell two configurations apart and to match against a console.
 */
export function gatewayLabel(id: string, names: GatewayNames = {}): string {
  if (id === NO_GATEWAY) return id
  return names[id] ?? id.slice(0, 8)
}

/** The full id, for a tooltip or a copy action — never truncated silently. */
export const gatewayTitle = (id: string, names: GatewayNames = {}): string =>
  id === NO_GATEWAY ? id : names[id] ? `${names[id]} · ${id}` : id
