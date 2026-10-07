import { airiaHeaders, type Connection } from './endpoint'

/**
 * The name of the tenant a key belongs to, so the page says whose data it
 * is showing. Every tenant's dashboard is otherwise identical, and a
 * screenshot or a pasted report carried nothing to say which one it was.
 *
 * `/v1/Tenants` answers with the key's own tenant as ONE object, not a
 * list, despite the plural — reached through the same proxy and with the
 * same `x-api-key` as everything else.
 *
 * Allowed to fail, like the gateway names: a key without the permission,
 * or a shape this does not recognise, yields null and the page simply
 * names no tenant. Only the name is kept.
 */
export async function fetchTenantName(conn: Connection, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch('/airia/v1/Tenants', {
      signal,
      headers: airiaHeaders(conn),
    })
    if (!res.ok) return null
    const body = (await res.json()) as unknown
    // One object today; tolerate a list or an `items` envelope in case it
    // ever becomes what the plural promises.
    const first = Array.isArray(body) ? body[0]
      : Array.isArray((body as { items?: unknown[] })?.items) ? (body as { items: unknown[] }).items[0]
      : body
    if (typeof first !== 'object' || first === null) return null
    const r = first as Record<string, unknown>
    const name = [r.name, r.identifier].find((v): v is string => typeof v === 'string' && v.trim() !== '')
    return name?.trim() ?? null
  } catch {
    // Aborted, offline, or an unreadable body — all the same answer.
    return null
  }
}
