/** Runtime stand-in for the app's `@/components/ui/dialog.js`.
 *
 *  The real one portals into `document.body` and animates; what a test of a
 *  dialog's CONTENT needs is only that `open` gates the children and that
 *  dismissing calls `onOpenChange(false)` — the two things the wrapper decides.
 *  Rendered inline rather than through a portal so a render test sees the tree
 *  where it stands.
 *
 *  Aliased in `vitest.config.ts`; `src/` still imports the real path. */

import type {ComponentProps, ReactNode} from 'react'

export const Dialog = (
  {open, onOpenChange, children}: {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    children: ReactNode
  },
) => open === false ? null : (
  <div role="dialog">
    {children}
    {/* The real `DialogContent` renders a close affordance; this is the seam a
        test uses to prove dismissal reaches `cancel`. */}
    <button type="button" aria-label="Close" onClick={() => onOpenChange?.(false)}/>
  </div>
)

export const DialogContent = (props: ComponentProps<'div'>) => <div {...props}/>
export const DialogHeader = (props: ComponentProps<'div'>) => <div {...props}/>
export const DialogFooter = (props: ComponentProps<'div'>) => <div {...props}/>
export const DialogTitle = (props: ComponentProps<'h2'>) => <h2 {...props}/>
export const DialogDescription = (props: ComponentProps<'p'>) => <p {...props}/>
