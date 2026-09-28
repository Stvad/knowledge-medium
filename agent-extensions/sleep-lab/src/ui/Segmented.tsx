/** A small pill-button group for a closed set of choices — the control kind
 *  in `StartExperimentDialog`, the population toggle in the analysis table.
 *  Shared rather than copied per call site (the Strength Tracker's
 *  `StartSessionDialog` re-declares its own copy; this extension has two
 *  call sites from the start, so one owner is the cheaper choice here).
 */
export const Segmented = <T extends string>({
  options, value, onChange,
}: {
  options: readonly {value: T; label: string}[]
  value: T
  onChange: (next: T) => void
}) => (
  <div className="flex flex-wrap gap-1">
    {options.map(option => (
      <button
        key={option.value}
        type="button"
        aria-pressed={option.value === value}
        data-block-interaction="ignore"
        className={option.value === value
          ? 'rounded bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground'
          : 'rounded border border-border px-2.5 py-1.5 text-sm hover:bg-muted'}
        onClick={event => {
          event.stopPropagation()
          onChange(option.value)
        }}
      >{option.label}</button>
    ))}
  </div>
)
Segmented.displayName = 'Segmented'
