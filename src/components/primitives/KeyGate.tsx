import { useId, useState } from 'react'
import { apiHost, envName, KNOWN_ENVIRONMENTS } from '../../lib/airia/endpoint'

export interface KeyGateProps {
  onSubmit: (key: string, remember: boolean, host: string) => void
  /** The API host the environment field starts on. */
  initialHost: string
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
 *
 * A key is also scoped to one ENVIRONMENT — the shared cloud or a cloud-prem
 * customer's own — so the gate asks for that beside it. The field takes the
 * address people log in at (`https://example.airia.ai`) or just its name,
 * and shows the API host it resolved to, so a typo is visible before the
 * key is sent anywhere.
 */
export function KeyGate({ onSubmit, initialHost, busy, error }: KeyGateProps) {
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(false)
  const [env, setEnv] = useState(() => envName(initialHost))
  const host = apiHost(env)
  const listId = useId()
  const ready = value.trim() !== '' && host != null

  return (
    <div className="gate" data-busy={busy ? '' : undefined}>
      <form
        className="gate__card"
        onSubmit={(e) => { e.preventDefault(); if (ready) onSubmit(value.trim(), remember, host) }}
      >
        <h2>Connect a tenant</h2>
        <p className="gate__lead">
          Paste an Airia API key. A key is scoped to one tenant, so this builds the
          dashboard for whichever tenant the key belongs to.
        </p>

        <label className="gate__label" htmlFor="airia-env">Environment</label>
        <input
          id="airia-env"
          className="gate__input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="prodaus, or https://yourco.airia.ai"
          list={listId}
          value={env}
          disabled={!!busy}
          onChange={(e) => setEnv(e.target.value)}
        />
        <datalist id={listId}>
          {KNOWN_ENVIRONMENTS.map((k) => <option key={k.host} value={envName(k.host)}>{k.label}</option>)}
        </datalist>
        <p className="gate__hint" aria-live="polite">
          {host ? <>API: <code>{host}</code></> : env.trim() ? 'Not a host name.' : 'The address you log in to Airia at.'}
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

        <button className="gate__submit" type="submit" disabled={!!busy || !ready}>
          {busy ?? 'Build dashboard'}
        </button>

        <p className="gate__note">
          The key is held in this tab and sent only to the Airia environment above. Ticking
          remember keeps it in <code>sessionStorage</code>, which clears when the
          tab closes — leave it off on a shared machine. Nothing is stored on a
          server, and no tenant data is written to disk.
        </p>
      </form>
    </div>
  )
}
