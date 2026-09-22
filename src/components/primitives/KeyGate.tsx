import { useState } from 'react'

export interface KeyGateProps {
  onSubmit: (key: string, remember: boolean) => void
  /** Non-null while a submitted key is being checked or data loaded. */
  busy?: string | null
  error?: string | null
}

/**
 * Asks for an Airia API key.
 *
 * A key is scoped to one tenant, so pasting a different key is what makes this
 * dashboard someone else's dashboard. Nothing is stored on a server and no
 * tenant data is written to disk — the key stays in this tab and the figures
 * are built in the browser.
 */
export function KeyGate({ onSubmit, busy, error }: KeyGateProps) {
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(false)

  return (
    <div className="gate">
      <form
        className="gate__card"
        onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSubmit(value.trim(), remember) }}
      >
        <h2>Connect a tenant</h2>
        <p className="gate__lead">
          Paste an Airia API key. A key is scoped to one tenant, so this builds the
          dashboard for whichever tenant the key belongs to.
        </p>

        <label className="gate__label" htmlFor="airia-key">API key</label>
        <input
          id="airia-key"
          className="gate__input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="akey_…"
          value={value}
          disabled={!!busy}
          onChange={(e) => setValue(e.target.value)}
        />

        <label className="gate__remember">
          <input
            type="checkbox"
            checked={remember}
            disabled={!!busy}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Remember for this browser tab
        </label>

        {error ? <p className="gate__error" role="alert">{error}</p> : null}

        <button className="gate__submit" type="submit" disabled={!!busy || value.trim() === ''}>
          {busy ?? 'Build dashboard'}
        </button>

        <p className="gate__note">
          The key is held in this tab and sent only to the Airia API. Ticking
          remember keeps it in <code>sessionStorage</code>, which clears when the
          tab closes — leave it off on a shared machine. Nothing is stored on a
          server, and no tenant data is written to disk.
        </p>
      </form>
    </div>
  )
}
