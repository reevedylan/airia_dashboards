import { NO_GATEWAY } from './aggregate'

/**
 * Names for gateway configurations.
 *
 * Executions carry only `gatewayConfigurationId`, a bare UUID, so the
 * breakdown and the filter would otherwise list rows of hex. Names come
 * from a different endpoint on the same host — `/v1/GatewayConfiguration`,
 * not the `/api/marketplace/v1/` the executions live under — reached
 * through the same proxy and with the same `x-api-key`.
 *
 * The lookup is still allowed to fail. It is a separate resource and a
 * separate permission, so a dashboard that only worked when it succeeded
 * would be a dashboard that broke for some keys. Failure yields no names,
 * every gateway shows a short id, and nothing else notices.
 */

/** `PageSize` the API accepts; 48 configurations fit in one page today. */
const PAGE_SIZE = 100
/** A guard on the paging loop, not an expectation. */
const MAX_PAGES = 20

/** Gateway id → display label, already disambiguated. */
export type GatewayNames = Readonly<Record<string, string>>

interface ConfigPage {
  items?: Array<{ id?: unknown; name?: unknown }>
  totalCount?: number
}

/**
 * Make every label unique.
 *
 * Names are not unique in practice and the duplicates are not rare: this
 * tenant has two `Codex`, two `claude-bedrock` and four
 * `Untitled gateway configuration`. Four identical rows in a filter is
 * worse than four UUIDs, so a shared name keeps a short id beside it.
 *
 * Disambiguated against ALL configurations rather than the ones in the
 * window, so a label does not change as the range moves.
 */
function disambiguate(raw: Map<string, string>): GatewayNames {
  const count = new Map<string, number>()
  for (const name of raw.values()) count.set(name, (count.get(name) ?? 0) + 1)
  const out: Record<string, string> = {}
  for (const [id, name] of raw) {
    out[id] = (count.get(name) ?? 0) > 1 ? `${name} (${short(id)})` : name
  }
  return out
}

/**
 * Pull `{ id: name }` out of a page and drop everything else.
 *
 * The payload carries each configuration's API keys, routing rules and
 * provider credentials. None of that is wanted here, and holding it for
 * the life of the tab would be a liability rather than a feature, so only
 * the two fields survive the read.
 *
 * Shape-tolerant on purpose: a bare array or an `items` envelope, and the
 * first name-ish field it finds.
 */
function readNames(payload: unknown, into: Map<string, string>): number {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as ConfigPage)?.items)
      ? (payload as ConfigPage).items!
      : []
  for (const row of list) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const id = r.id ?? r.gatewayConfigurationId ?? r.configurationId
    const name = r.name ?? r.displayName ?? r.gatewayName ?? r.title
    if (typeof id === 'string' && typeof name === 'string' && name.trim() !== '') {
      into.set(id, name.trim())
    }
  }
  return list.length
}

export async function fetchGatewayNames(key: string, signal?: AbortSignal): Promise<GatewayNames> {
  const raw = new Map<string, string>()
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(
        `/airia/v1/GatewayConfiguration?PageNumber=${page}&PageSize=${PAGE_SIZE}`,
        { signal, headers: { 'x-api-key': key, accept: 'application/json' } },
      )
      // A key without this permission answers 401/403, which is an ordinary
      // outcome here and not worth surfacing: ids are a usable fallback.
      if (!res.ok) break
      const body = (await res.json()) as ConfigPage
      const got = readNames(body, raw)
      const total = typeof body?.totalCount === 'number' ? body.totalCount : 0
      if (got < PAGE_SIZE || raw.size >= total) break
    }
  } catch {
    // Aborted, offline, or an unreadable body — all the same answer.
  }
  return disambiguate(raw)
}

/** Enough of a UUID to tell two apart and to match against the console. */
const short = (id: string) => id.slice(0, 8)

/**
 * What to show for a gateway.
 *
 * A short id rather than the full UUID when there is no name: 36 characters
 * of hex is unreadable in a filter list, and the first block is enough to
 * recognise.
 */
export function gatewayLabel(id: string, names: GatewayNames = {}): string {
  if (id === NO_GATEWAY) return id
  return names[id] ?? short(id)
}

/**
 * The full id for a tooltip, and an explanation when there is no name for
 * it.
 *
 * Unresolved ids are not an edge case: the endpoint lists configurations
 * that exist NOW, while executions keep referring to ones since deleted —
 * 9 of the 39 gateways in this tenant's year, one of them with 3,212 calls.
 * Saying so beats leaving a column of hex unexplained.
 */
export function gatewayTitle(id: string, names: GatewayNames = {}): string {
  if (id === NO_GATEWAY) return id
  const name = names[id]
  if (name) return `${name}\n${id}`
  if (Object.keys(names).length > 0) {
    return `${id}\nNot in the current gateway list — this configuration has probably been deleted.`
  }
  return id
}

/** True once a lookup has produced anything, for copy that depends on it. */
export const hasGatewayNames = (names: GatewayNames): boolean => Object.keys(names).length > 0
