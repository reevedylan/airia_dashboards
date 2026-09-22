import { useEffect, useState } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'

const KEY = 'viz-kit-theme'

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* private mode, blocked storage — fall through */ }
  return 'system'
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
}

/** Theme toggle backed by `data-theme` on <html>, which `tokens.css` reads. */
export function useTheme(): [ThemeChoice, (next: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(read)

  useEffect(() => {
    apply(choice)
    try { localStorage.setItem(KEY, choice) } catch { /* non-fatal */ }
  }, [choice])

  return [choice, setChoice]
}
