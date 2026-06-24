import { useCallback, useState } from 'react'
import type { Block } from '@/data/block'
import { withMoveTransition } from '@/utils/viewTransition.js'

export interface PromotableBreadcrumb {
  /** The block currently shown as the subtree root — the original root
   *  until the user promotes (unfurls) an ancestor. */
  shownId: string
  /** Whether the shown block is still the original root (no promotion). */
  isInitial: boolean
  /** Promote a breadcrumb ancestor to the shown block. */
  promote: (parent: Block) => void
  /** Show an arbitrary block id (e.g. a keyboard "promote closest"). */
  showBlock: (blockId: string) => void
}

/** Shared state for "promote-in-place" breadcrumbs: clicking an ancestor
 *  unfurls it as the shown subtree root, with the same crossfade as panel
 *  breadcrumb navigation. The shown id resets to `rootId` whenever it
 *  changes, so a surface whose root swaps under it (e.g. the SRS card
 *  advancing) snaps back to the new root; for a stable root (e.g. a
 *  backlink entry) the reset never fires. */
export function usePromotableBreadcrumb(rootId: string): PromotableBreadcrumb {
  const [shownId, setShownId] = useState(rootId)
  // Reset on root change, the "adjust state during render" pattern — no
  // effect, so the new root paints in the same commit.
  const [prevRoot, setPrevRoot] = useState(rootId)
  if (prevRoot !== rootId) {
    setPrevRoot(rootId)
    setShownId(rootId)
  }

  // Local React state, not a DB write, so the crossfade wrap lives here
  // rather than coming from `navigateInPanel`.
  const showBlock = useCallback((blockId: string) => {
    void withMoveTransition(async () => { setShownId(blockId) })
  }, [])
  const promote = useCallback((parent: Block) => { showBlock(parent.id) }, [showBlock])

  return { shownId, isInitial: shownId === rootId, promote, showBlock }
}
