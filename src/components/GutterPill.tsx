import type { ComponentType, MouseEvent, SVGProps } from 'react'

const RESTING_TONES = {
  muted: 'bg-muted text-muted-foreground',
  amber: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100',
} as const

/** The shape every pill in a block's gutter shares, so pills from different
 *  plugins line up side by side; the gutter centres them on the first line. */
export const GUTTER_PILL_CLASS = 'inline-flex h-4 shrink-0 select-none items-center rounded-full text-xs leading-none'

/** A small rounded count pill in a block's gutter that toggles an inline
 *  section under the block. */
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
    className={`${GUTTER_PILL_CLASS} min-w-4 justify-center gap-0.5 px-1 tabular-nums transition-colors ${
      expanded
        ? 'bg-accent text-accent-foreground'
        : `${RESTING_TONES[tone]} hover:bg-accent hover:text-accent-foreground`
    }`}
  >
    {Icon && <Icon className="h-3 w-3" aria-hidden/>}
    {count ? count : null}
  </button>
)
