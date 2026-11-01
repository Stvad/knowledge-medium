import { ReactNode } from 'react'
import { Block } from '@/data/block'
import { useRepo } from '@/context/repo'
import { useWorkspaceId } from '@/hooks/block'
import { useAppHashInContext } from '@/context/layoutWsContext'
import { useOpenBlock } from '@/utils/navigation'

import { BlockLink } from './BlockLink'
import { classifyLinkInteraction } from './linkInteraction'

/**
 * A click that concludes a TEXT SELECTION anchored inside the reference (a
 * drag-select, a double-click-to-select) shouldn't navigate and throw the
 * selection away. A plain click collapses any prior selection on `mousedown`, so
 * a non-collapsed selection at click time was produced by this very gesture; we
 * only treat it as ours when its anchor (where the selection started) is inside
 * the reference, so a stray selection elsewhere on the page doesn't block nav.
 */
const concludesTextSelection = (currentTarget: Element): boolean => {
  if (typeof window === 'undefined') return false
  const selection = window.getSelection()
  return !!selection && !selection.isCollapsed && currentTarget.contains(selection.anchorNode)
}

/**
 * The navigating anchor a block reference wraps its content in: a
 * workspace-scoped link that opens the target block on click. Shared by the
 * reference layout (wrapping the target's raw content) and `BlockRef`'s alias
 * short-circuit (wrapping the alias text, without mounting the target), so the
 * href / open-block behaviour lives in one place.
 */
export function ReferenceLink({block, children}: {block: Block; children: ReactNode}) {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')
  const openBlock = useOpenBlock({blockId: block.id, workspaceId})
  const href = useAppHashInContext(workspaceId, block.id)

  return (
    <BlockLink
      blockId={block.id}
      workspaceId={workspaceId}
      href={href}
      className="blockref text-inherit underline decoration-dotted decoration-muted-foreground/60 underline-offset-[0.18em] cursor-pointer rounded-sm px-0.5 hover:bg-muted/60 hover:decoration-muted-foreground/75"
      data-block-id={block.id}
      // An `<a>` is draggable by default, which would start a native LINK drag on
      // press-drag inside the reference — hijacking a video's scrub or an image's
      // drag-out (the now-default presentation of pasted media). Opt the link out
      // so the rich content's own pointer gestures work.
      draggable={false}
      onClick={(event) => {
        // Nested links keep their navigation. Other interactive content owns
        // the gesture, so suppress this reference's href even with modifiers.
        const owner = classifyLinkInteraction(event)
        if (owner === 'anchor') return
        if (owner === 'rich') {
          event.preventDefault()
          return
        }
        // Don't navigate (and discard the selection) when the click just finished
        // selecting text inside the reference.
        if (concludesTextSelection(event.currentTarget)) return
        openBlock(event)
      }}
    >
      {children}
    </BlockLink>
  )
}
