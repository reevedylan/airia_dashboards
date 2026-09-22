import { useEffect, useMemo, useRef, useState } from 'react'

export interface MultiSelectProps {
  label: string
  options: readonly string[]
  /** Empty means "all" — the filter is inert rather than excluding everything. */
  selected: ReadonlySet<string>
  /**
   * Toggle ONE option. Relative rather than absolute on purpose: computing the
   * next Set from the `selected` prop loses a toggle when two land in the same
   * render batch, because both read the same stale value. The parent applies
   * this against its own previous state.
   */
  onToggle: (value: string) => void
  /** Absolute replacement, for the bulk actions where that is the intent. */
  onChange: (next: Set<string>) => void
  /** Shown when nothing is selected. */
  allLabel?: string
  /** Rendered instead of a raw option value (e.g. to mark a synthetic entry). */
  renderOption?: (value: string) => React.ReactNode
  placeholder?: string
}

/**
 * Multi-select with search-as-you-type.
 *
 * A plain listbox does not scale here: the option list is people, not a fixed
 * set like the models, so it is unbounded and cannot be eyeballed. Filtering
 * by typing is the only thing that stays usable as it grows.
 *
 * An empty selection means "all", not "none". Treating it as "none" would make
 * clearing the last option blank the entire dashboard, which nobody intends.
 */
export function MultiSelect({
  label, options, selected, onToggle, onChange,
  allLabel = 'All', renderOption, placeholder = 'Search…',
}: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  // Close on outside click or Escape — a popover that traps the page is worse
  // than no popover.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => { if (open) search.current?.focus() }, [open])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q === '' ? options : options.filter((o) => o.toLowerCase().includes(q))
  }, [options, query])

  const summary = selected.size === 0
    ? allLabel
    : selected.size === 1
      ? [...selected][0]
      : `${selected.size} selected`

  return (
    <div className="viz-msel" ref={root}>
      <button
        type="button"
        className="viz-btn viz-msel__trigger"
        aria-expanded={open}
        aria-haspopup="listbox"
        data-active={selected.size > 0 ? '' : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <UserIcon />
        <span className="viz-msel__label">{label}</span>
        <span className="viz-msel__summary">{summary}</span>
        <ChevronIcon />
      </button>

      {open ? (
        <div className="viz-msel__pop" role="dialog" aria-label={label}>
          <input
            ref={search}
            className="viz-msel__search"
            type="search"
            value={query}
            placeholder={placeholder}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="viz-msel__list" role="listbox" aria-multiselectable="true">
            {shown.length === 0 ? (
              <p className="viz-msel__empty">No matches</p>
            ) : (
              shown.map((o) => {
                const on = selected.has(o)
                return (
                  <button
                    key={o}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className="viz-msel__opt"
                    onClick={() => onToggle(o)}
                  >
                    <span className="viz-msel__check" aria-hidden="true">{on ? <CheckIcon /> : null}</span>
                    <span className="viz-msel__opt-label">{renderOption ? renderOption(o) : o}</span>
                  </button>
                )
              })
            )}
          </div>

          <div className="viz-msel__foot">
            <button
              type="button"
              className="viz-msel__action"
              disabled={selected.size === 0}
              onClick={() => onChange(new Set())}
            >
              Clear ({allLabel.toLowerCase()})
            </button>
            <button
              type="button"
              className="viz-msel__action"
              disabled={shown.length === 0}
              onClick={() => onChange(new Set(shown))}
            >
              {query.trim() === '' ? 'Select all' : `Select ${shown.length} shown`}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

const UserIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="5.5" r="2.75" />
    <path d="M2.75 14c0-2.9 2.35-4.5 5.25-4.5s5.25 1.6 5.25 4.5" />
  </svg>
)

const ChevronIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6.5l4 4 4-4" />
  </svg>
)

const CheckIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8.5l3.5 3.5L13 5" />
  </svg>
)
