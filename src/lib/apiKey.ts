import { useCallback, useState } from 'react'

const STORE_KEY = 'airia-api-key'

/**
 * Holds the pasted API key.
 *
 * In memory by default. Remembering is opt-in and uses sessionStorage, not
 * localStorage: it clears when the tab closes, so a key does not outlive the
 * session on a shared machine. Either way it never goes into a URL or a log.
 */
export function useApiKey() {
  const [key, setKeyState] = useState<string | null>(() => {
    try { return sessionStorage.getItem(STORE_KEY) } catch { return null }
  })
  const [remember, setRemember] = useState<boolean>(() => {
    try { return sessionStorage.getItem(STORE_KEY) != null } catch { return false }
  })

  const setKey = useCallback((next: string | null, persist = false) => {
    setKeyState(next)
    setRemember(persist)
    try {
      if (next && persist) sessionStorage.setItem(STORE_KEY, next)
      else sessionStorage.removeItem(STORE_KEY)
    } catch { /* private mode or blocked storage — memory only */ }
  }, [])

  const clear = useCallback(() => setKey(null, false), [setKey])

  return { key, setKey, clear, remember }
}

/** Never show a key in full. Enough to recognise, not enough to reuse. */
export const maskKey = (key: string): string =>
  key.length <= 10 ? '•'.repeat(key.length) : `${key.slice(0, 6)}…${key.slice(-4)}`
