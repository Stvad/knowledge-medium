import { cn } from '@/lib/utils.js'

const CRUMB_SEPARATOR = ' › '

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
 *  lands in it.
 *
 *  The line is the PATH and nothing else. It briefly also carried the
 *  row's type chips, which was a mistake worth recording: the chips come
 *  from a live registry, so anything sharing a conditionally-rendered
 *  line with them makes that line's presence — and the row's height —
 *  depend on the registry. Chips now ride the text line, which always
 *  exists and is taller than they are. Keep this box single-purpose.
 *
 *  `min-w-0` permits the shrink that lets `truncate` fire when the path
 *  outgrows its width; the path is unbounded and already degrades by
 *  design (see `CRUMB_MAX_SEGMENTS`). */
export const BlockCrumbs = ({
  crumbs,
  className,
}: {
  crumbs?: readonly string[]
  className?: string
}) => (
  <div
    className={cn('h-4 min-w-0 truncate text-xs leading-4 text-muted-foreground', className)}
    data-block-crumbs=""
  >
    {crumbs && crumbs.length > 0 ? crumbs.join(CRUMB_SEPARATOR) : null}
  </div>
)
