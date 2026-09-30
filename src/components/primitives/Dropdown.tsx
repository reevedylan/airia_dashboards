import { usePopover } from './popover'

export interface DropTriggerProps {
  /** What the trigger reads as now. */
  label: React.ReactNode
  /**
   * Every label this trigger can show. They share a grid cell with the
   * visible one, invisibly, so the trigger is always as wide as its longest
   * form: a control that changes width moves everything beside it.
   */
  sizers?: readonly string[]
  open: boolean
  onClick: () => void
  /** Tinted: a filter is narrowing the data, or the window is not live. */
  active?: boolean
  title?: string
  ariaLabel?: string
  className?: string
  ref?: React.Ref<HTMLButtonElement>
}

/**
 * The toolbar's one trigger shape: plain text and a chevron, no box.
 *
 * Borderless on purpose. A row of five outlined controls reads as a form;
 * text with a chevron reads as a sentence about what is on screen — "All
 * users, all gateways, last 7 days, hourly" — and only looks like a control
 * when you reach for it.
 */
export function DropTrigger({
  label, sizers, open, onClick, active, title, ariaLabel, className, ref,
}: DropTriggerProps) {
  return (
    <button
      ref={ref}
      type="button"
      className={className ? `viz-drop ${className}` : 'viz-drop'}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={ariaLabel}
      data-active={active ? '' : undefined}
      title={title}
      onClick={onClick}
    >
      <span className="viz-drop__label">
        <span>{label}</span>
        {sizers?.map((s) => <span key={s} className="viz-drop__sizer" aria-hidden="true">{s}</span>)}
      </span>
      <ChevronDown />
    </button>
  )
}

export interface SelectMenuOption<T> {
  value: T
  label: string
  /** Muted text after the label, e.g. "default". */
  hint?: string
}

export interface SelectMenuProps<T extends string | number> {
  /** Heading inside the menu, e.g. "Granularity". Also its accessible name. */
  heading: string
  value: T
  options: readonly SelectMenuOption<T>[]
  onChange: (next: T) => void
  className?: string
}

/** A single choice from a short list, with a check on the chosen one. */
export function SelectMenu<T extends string | number>({
  heading, value, options, onChange, className,
}: SelectMenuProps<T>) {
  const p = usePopover()
  const current = options.find((o) => o.value === value)
  return (
    <div className="viz-dropwrap" ref={p.root}>
      <DropTrigger
        ref={p.trigger}
        className={className}
        label={current?.label ?? String(value)}
        sizers={options.map((o) => o.label)}
        open={p.open}
        ariaLabel={`${heading}: ${current?.label ?? value}`}
        onClick={() => p.setOpen((v) => !v)}
      />
      {p.open ? (
        <div className="viz-menu" role="dialog" aria-label={heading} ref={p.pop}>
          <p className="viz-menu__head">{heading}</p>
          <div role="listbox" aria-label={heading}>
            {options.map((o) => (
              <button
                key={String(o.value)}
                type="button"
                role="option"
                className="viz-menu__item"
                aria-selected={o.value === value}
                onClick={() => { onChange(o.value); p.close() }}
              >
                <span>
                  {o.label}
                  {o.hint ? <span className="viz-menu__hint">{o.hint}</span> : null}
                </span>
                {o.value === value ? <CheckIcon /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export const ChevronDown = () => (
  <svg className="viz-drop__chev" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6.5l4 4 4-4" />
  </svg>
)

export const CheckIcon = () => (
  <svg className="viz-menu__check" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8.5l3.5 3.5L13 5" />
  </svg>
)
