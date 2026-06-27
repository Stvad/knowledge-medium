import { ReactNode, type MouseEvent } from 'react'
import { Block } from '@/data/block'
import { useRepo } from '@/context/repo'
import { useWorkspaceId } from '@/hooks/block'
import { buildAppHash } from '@/utils/routing'
import { useOpenBlock } from '@/utils/navigation'
import { isSelectionClick } from '@/extensions/blockInteraction'

// Content that owns its own click inside a reference: a media image's zoom
// lightbox, a video player's controls/iframe, a nested reference or markdown
// link, an explicit opt-out. NOTE: this deliberately matches the link's *inner*
// content, never the reference's own wrapping `<a href>` (which the walk below
// excludes via `currentTarget`).
const RICH_CONTENT_SELECTOR =
  'img, video, audio, iframe, canvas, button, a[href], [role="button"], [data-block-interaction="ignore"]'

/** A reference wraps the target's RAW content in a navigating link, but rich raw
 *  content has its own click behaviour (a video player's controls, an image's
 *  zoom lightbox, a nested reference/link). Those clicks should drive the
 *  content, NOT navigate. Walk from the click target up to — but NOT including —
 *  the reference link itself (`currentTarget`): a rich/interactive element
 *  between them owns the click. Excluding `currentTarget` is essential — the
 *  reference's OWN `<a href>` is an `a[href]` ancestor of every click, so
 *  matching it would suppress navigation for plain text too. */
export const rawContentOwnsClick = (event: MouseEvent): boolean => {
  const { target, currentTarget } = event
  if (!(target instanceof Element)) return false
  for (let el: Element | null = target; el && el !== currentTarget; el = el.parentElement) {
    if (el.matches(RICH_CONTENT_SELECTOR)) return true
  }
  return false
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
        // A PLAIN click on rich raw content (video player, image lightbox, a
        // nested link) belongs to the content, so suppress the link's
        // navigation. Modified clicks (cmd/ctrl/shift) still reach the opener,
        // so "open in a new panel" keeps working anywhere on the reference.
        if (!isSelectionClick(event) && rawContentOwnsClick(event)) {
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
