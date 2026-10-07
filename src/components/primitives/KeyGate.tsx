import { useState } from 'react'
import { apiHost, envName, regionOf, REGIONS } from '../../lib/airia/endpoint'

const CUSTOM = 'custom'

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
 * A key is also scoped to one ENVIRONMENT, so the gate asks for that
 * beside it: one of Airia's SaaS regions from a menu, or Custom for a
 * customer's own. Custom takes the address people log in at
 * (`https://example.airia.ai`) or just its name. Either way the API host it
 * resolves to is shown, so a typo is visible before the key is sent
 * anywhere.
 */
export function KeyGate({ onSubmit, initialHost, busy, error }: KeyGateProps) {
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(false)
  /* A region's host, or CUSTOM. A remembered custom host reopens as
     Custom with its name filled in. */
  const [region, setRegion] = useState(() => regionOf(initialHost)?.host ?? CUSTOM)
  const [custom, setCustom] = useState(() => (regionOf(initialHost) ? '' : envName(initialHost)))
  const host = region === CUSTOM ? apiHost(custom) : region
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

        {/* Every field is a group — label, control(s), optional hint — and
            groups are spaced by one gap, so a hint under a control cannot
            push the next label further down than the others sit. */}
        <div className="gate__field">
          <label className="gate__label" htmlFor="airia-region">Region</label>
          <div className="gate__select">
            <select
              id="airia-region"
              className="gate__input"
              value={region}
              disabled={!!busy}
              onChange={(e) => setRegion(e.target.value)}
            >
              {REGIONS.map((r) => <option key={r.host} value={r.host}>{r.flag} {r.label}</option>)}
              <option value={CUSTOM}>Custom…</option>
            </select>
          </div>
          {region === CUSTOM ? (
            <input
              id="airia-env"
              className="gate__input"
              type="text"
              aria-label="Custom environment address"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://yourco.airia.ai"
              value={custom}
              disabled={!!busy}
              autoFocus
              onChange={(e) => setCustom(e.target.value)}
            />
          ) : null}
          <p className="gate__hint" aria-live="polite">
            {host ? <>API <code>{host}</code></>
              : custom.trim() ? 'Not a host name.'
              : 'The address you log in to Airia at.'}
          </p>
        </div>

        <div className="gate__field">
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
        </div>

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
