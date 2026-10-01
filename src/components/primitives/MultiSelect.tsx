import { useEffect, useMemo, useRef, useState } from 'react'
import { DropTrigger } from './Dropdown'
import { Check } from './icons'
import { usePopover } from './popover'

export interface MultiSelectProps {
  /** Heading inside the popover, e.g. "Filter users". Also its accessible name. */
  label: string
  /** Plural noun for the trigger once several are picked: "3 users". */
  noun?: string
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
  /**
   * The text an option READS as, when that differs from its value.
   *
   * Needed whenever the value is an opaque id: searching and the trigger
   * summary both work off this, so typing a gateway's name finds it and
   * the chosen one is named rather than shown as a UUID. Rendering can
   * still be overridden separately with `renderOption`.
   */
  optionText?: (value: string) => string
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
  allLabel = 'All', renderOption, optionText, placeholder = 'Search…', noun = 'selected',
}: MultiSelectProps) {
  const text = optionText ?? ((v: string) => v)
  const { open, setOpen, root, trigger, pop } = usePopover()
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)

  useEffect(() => { if (open) search.current?.focus() }, [open])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    // Matched against what the option READS as, not its value: searching a
    // list of UUIDs for the name printed on it should find it.
    return q === '' ? options : options.filter((o) => text(o).toLowerCase().includes(q))
  }, [options, query, text])

  const summary = selected.size === 0
    ? allLabel
    : selected.size === 1
      ? text([...selected][0])
      : `${selected.size} ${noun}`

  return (
    <div className="viz-dropwrap viz-msel" ref={root}>
      <DropTrigger
        ref={trigger}
        className="viz-msel__trigger"
        label={<span className="viz-msel__summary">{summary}</span>}
        open={open}
        active={selected.size > 0}
        ariaLabel={`${label}: ${summary}`}
        title={selected.size > 1 ? [...selected].map(text).join(', ') : undefined}
        onClick={() => setOpen((v) => !v)}
      />

      {open ? (
        <div className="viz-msel__pop" role="dialog" aria-label={label} ref={pop}>
          {/* No visible heading: the trigger says "All users" and the box
              says "Search users…", so a "Filter users" title only repeated
              them. It stays as the accessible name. */}
          <input
            ref={search}
            className="viz-msel__search"
            type="search"
            aria-label={label}
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
                    <span className="viz-msel__check" aria-hidden="true">{on ? <Check size={12} /> : null}</span>
                    <span className="viz-msel__opt-label">{renderOption ? renderOption(o) : o}</span>
                  </button>
                )
              })
            )}
          </div>

          {/*
            No "Select all". An empty selection already MEANS all, so ticking
            every box was a second way to say nothing. Selecting the matches
            of a SEARCH is different — it narrows, e.g. everyone at one
            domain — so that offer appears only while a search hides some
            options, and it adds to what is already picked rather than
            replacing it.
          */}
          <div className="viz-msel__foot">
            <button
              type="button"
              className="viz-msel__action"
              disabled={selected.size === 0}
              onClick={() => onChange(new Set())}
            >
              Clear all
            </button>
            {query.trim() !== '' && shown.length > 0 && shown.length < options.length ? (
              <button
                type="button"
                className="viz-msel__action"
                disabled={shown.every((o) => selected.has(o))}
                onClick={() => onChange(new Set([...selected, ...shown]))}
              >
                Select {shown.length} shown
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

