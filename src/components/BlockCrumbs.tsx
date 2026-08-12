import { cn } from '@/lib/utils.js'

export const CRUMB_SEPARATOR = ' › '

/** The ancestor-path line above a search result's content.
 *
 *  The height is FIXED and the element renders unconditionally — including
 *  for `undefined` (crumbs still loading) and `[]` (a block with no
 *  ancestors). That is the whole point of the component: crumbs arrive on
 *  a second, batched query after the results are already painted
 *  (`useAncestorCrumbs`), so if the line only existed once it had text,
 *  every row below it would jump the moment that query resolved — under a
 *  cursor that is mid-keyboard-selection. Reserving the line up front
 *  makes the fill-in a pure repaint.
 *
 *  `h-4` / `leading-4` / `text-xs` are one 16px line exactly; keep them in
 *  step if the type scale changes, or the reserved box stops matching what
 *  lands in it. */
export const BlockCrumbs = ({
  crumbs,
  className,
}: {
  crumbs?: readonly string[]
  className?: string
}) => (
  <div
    className={cn('h-4 w-full truncate text-xs leading-4 text-muted-foreground', className)}
    data-block-crumbs=""
  >
    {crumbs && crumbs.length > 0 ? crumbs.join(CRUMB_SEPARATOR) : null}
  </div>
)
