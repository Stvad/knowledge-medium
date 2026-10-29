import type { ComponentType, MouseEvent, SVGProps } from 'react'

const RESTING_TONES = {
  muted: 'bg-muted text-muted-foreground',
  amber: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100',
} as const

/** A small rounded count pill in a block's right gutter that toggles an inline
 *  section under the block. Pills from different plugins sit side by side on
 *  one line, so they share this one shape. */
export const GutterPill = ({
  count,
  expanded,
  onClick,
  label,
  icon: Icon,
  tone = 'muted',
}: {
  /** null and 0 show no number. */
  count: number | null
  expanded: boolean
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  /** The accessible name and the tooltip. */
  label: string
  icon?: ComponentType<SVGProps<SVGSVGElement>>
  /** The colour while not expanded; an expanded pill is always the accent. */
  tone?: keyof typeof RESTING_TONES
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-expanded={expanded}
    aria-label={label}
    title={label}
    className={`mt-0.5 inline-flex h-4 min-w-4 shrink-0 select-none items-center justify-center gap-0.5 rounded-full px-1 text-xs leading-none tabular-nums transition-colors ${
      expanded
        ? 'bg-accent text-accent-foreground'
        : `${RESTING_TONES[tone]} hover:bg-accent hover:text-accent-foreground`
    }`}
  >
    {Icon && <Icon className="h-3 w-3" aria-hidden/>}
    {count ? count : null}
  </button>
)
