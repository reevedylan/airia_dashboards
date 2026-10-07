import { useCallback, useMemo, useState } from 'react'
import { DEFAULT_HOST, type Connection } from './airia/endpoint'

const STORE_KEY = 'airia-api-key'
const STORE_HOST = 'airia-host'
/** The last environment connected to, so the gate opens on it. A hostname,
 *  not a credential and not tenant data, so it may outlive the tab. */
const LAST_HOST = 'airia-last-host'

const read = (store: () => Storage, k: string): string | null => {
  try { return store().getItem(k) } catch { return null }
}

/**
 * Holds the pasted API key and the environment it belongs to.
 *
 * In memory by default. Remembering is opt-in and uses sessionStorage, not
 * localStorage: it clears when the tab closes, so a key does not outlive the
 * session on a shared machine. Either way it never goes into a URL or a log.
 *
 * `conn` is memoised on (key, host), so it is stable across renders and the
 * fetch hooks can depend on it, and cache on it, by identity.
 */
export function useApiKey() {
  const [key, setKeyState] = useState<string | null>(() => read(() => sessionStorage, STORE_KEY))
  const [host, setHost] = useState<string>(() => read(() => sessionStorage, STORE_HOST) ?? DEFAULT_HOST)
  const [remember, setRemember] = useState<boolean>(() => read(() => sessionStorage, STORE_KEY) != null)

  const setKey = useCallback((next: string | null, persist = false, nextHost?: string) => {
    setKeyState(next)
    setRemember(persist)
    if (nextHost) setHost(nextHost)
    try {
      if (next && persist) {
        sessionStorage.setItem(STORE_KEY, next)
        if (nextHost) sessionStorage.setItem(STORE_HOST, nextHost)
      } else {
        sessionStorage.removeItem(STORE_KEY)
        sessionStorage.removeItem(STORE_HOST)
      }
    } catch { /* private mode or blocked storage — memory only */ }
    if (nextHost) try { localStorage.setItem(LAST_HOST, nextHost) } catch { /* as above */ }
  }, [])

  const clear = useCallback(() => setKey(null, false), [setKey])

  const conn = useMemo<Connection | null>(() => (key ? { key, host } : null), [key, host])

  return { key, host, conn, setKey, clear, remember }
}

/** The environment the key gate should offer first. */
export const lastHost = (): string => read(() => localStorage, LAST_HOST) ?? DEFAULT_HOST

/** Never show a key in full. Enough to recognise, not enough to reuse. */
export const maskKey = (key: string): string =>
  key.length <= 10 ? '•'.repeat(key.length) : `${key.slice(0, 6)}…${key.slice(-4)}`
