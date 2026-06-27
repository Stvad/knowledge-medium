import { ReactNode, type MouseEvent } from 'react'
import { Block } from '@/data/block'
import { useRepo } from '@/context/repo'
import { useWorkspaceId } from '@/hooks/block'
import { buildAppHash } from '@/utils/routing'
import { useOpenBlock } from '@/utils/navigation'
import { isSelectionClick } from '@/extensions/blockInteraction'

// Non-anchor content that drives its OWN click inside a reference via a JS
// handler: a media image's zoom lightbox, a video player's controls/iframe, a
// button, an explicit opt-out. (Anchors are handled separately — see below.)
const RICH_CONTENT_SELECTOR =
  'img, video, audio, iframe, canvas, button, [role="button"], [data-block-interaction="ignore"]'

/**
 * Classify a click inside the reference link. Walk from the click target up to —
 * but NOT including — the reference link itself (`currentTarget`); whichever owner
 * is found closest to the target wins. Excluding `currentTarget` is essential:
 * the reference's OWN `<a href>` is an ancestor of every click, so counting it
 * would mishandle plain text.
 *
 *  - `'anchor'`: a nested `<a href>` (a markdown link, a nested reference). It
 *    owns navigation via its NATIVE default action / its own handler — so the
 *    reference must do nothing and must NOT `preventDefault`, or the inner link's
 *    navigation dies with it.
 *  - `'rich'`: non-anchor interactive/media content. It handled its own click
 *    (lightbox / play / button), so the reference suppresses its OWN navigation
 *    (`preventDefault`) but doesn't open the target.
 *  - `null`: plain content — the reference navigates to its target.
 */
export const classifyReferenceClick = (event: MouseEvent): 'anchor' | 'rich' | null => {
  const { target, currentTarget } = event
  if (!(target instanceof Element)) return null
  for (let el: Element | null = target; el && el !== currentTarget; el = el.parentElement) {
    if (el.matches('a[href]')) return 'anchor'
    if (el.matches(RICH_CONTENT_SELECTOR)) return 'rich'
  }
  return null
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
      // An `<a>` is draggable by default, which would start a native LINK drag on
      // press-drag inside the reference — hijacking a video's scrub or an image's
      // drag-out (the now-default presentation of pasted media). Opt the link out
      // so the rich content's own pointer gestures work.
      draggable={false}
      onClick={(event) => {
        // A modified click (cmd/ctrl/shift) reaches the opener — so plain text and
        // the link chrome open in a new panel; on a nested link the browser
        // follows that link instead. Otherwise, let the content own its click: a
        // nested link navigates natively (do nothing — NOT preventDefault, or its
        // nav dies too); other rich content (image lightbox, video controls)
        // handled itself, so suppress the reference's own navigation. Plain
        // content opens the reference target.
        const owner = isSelectionClick(event) ? null : classifyReferenceClick(event)
        if (owner === 'anchor') return
        if (owner === 'rich') {
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
