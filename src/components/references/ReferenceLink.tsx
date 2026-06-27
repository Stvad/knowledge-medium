import { ReactNode, type MouseEvent } from 'react'
import { Block } from '@/data/block'
import { useRepo } from '@/context/repo'
import { useWorkspaceId } from '@/hooks/block'
import { buildAppHash } from '@/utils/routing'
import { useOpenBlock } from '@/utils/navigation'
import { isInteractiveContentEvent } from '@/extensions/blockInteraction'

/** A reference wraps the target's RAW content in a navigating link, but rich raw
 *  content has its own click behaviour — a video player's controls, an image's
 *  zoom lightbox. Those clicks should drive the content, NOT navigate. (Plain
 *  text, and the link's own chrome, still navigate; cmd/middle-click still opens
 *  via `href`.) `isInteractiveContentEvent` already covers the video player
 *  (`video[controls]` / `iframe`); `img` covers the media-image lightbox. */
export const rawContentOwnsClick = (event: MouseEvent): boolean => {
  if (isInteractiveContentEvent(event)) return true
  const target = event.target
  return target instanceof Element && target.closest('img') !== null
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
  const href = buildAppHash(workspaceId, block.id)

  return (
    <a
      href={href}
      className="blockref text-inherit no-underline cursor-pointer rounded-sm px-0.5 hover:bg-muted/60"
      data-block-id={block.id}
      onClick={(event) => {
        // Let rich raw content (video player, image lightbox) handle its own
        // click instead of navigating — and suppress the link's default
        // navigation for it.
        if (rawContentOwnsClick(event)) {
          event.preventDefault()
          return
        }
        openBlock(event)
      }}
    >
      {children}
    </a>
  )
}
