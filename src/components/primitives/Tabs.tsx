export interface TabsProps<T extends string> {
  tabs: readonly { key: T; label: string }[]
  value: T
  onChange: (next: T) => void
  ariaLabel: string
}

/** Segmented tab switcher, sized to sit inside a card's headline row. */
export function Tabs<T extends string>({ tabs, value, onChange, ariaLabel }: TabsProps<T>) {
  return (
    <div className="viz-viewtoggle" role="tablist" aria-label={ariaLabel}>
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          aria-pressed={value === t.key}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
