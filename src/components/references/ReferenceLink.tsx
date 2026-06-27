import { ReactNode, type MouseEvent } from 'react'
import { Block } from '@/data/block'
import { useRepo } from '@/context/repo'
import { useWorkspaceId } from '@/hooks/block'
import { buildAppHash } from '@/utils/routing'
import { useOpenBlock } from '@/utils/navigation'

// Non-anchor content that drives its OWN click inside a reference via a JS
// handler: a media image's zoom lightbox, a video player's controls/iframe, a
// button, an explicit opt-out. (Anchors are handled separately — see below.)
const RICH_CONTENT_SELECTOR =
  'img, video, audio, iframe, canvas, button, [role="button"], [data-block-interaction="ignore"]'

/**
 * Classify a click inside the reference link. Walk from the click target up to —
 * but NOT including — the reference link itself (`currentTarget`). Excluding
 * `currentTarget` is essential: the reference's OWN `<a href>` is an ancestor of
 * every click, so counting it would mishandle plain text.
 *
 *  - `'anchor'`: an enclosing nested `<a href>` (a markdown link, a nested
 *    reference). A link is explicitly meant to be followed, so it wins over a
 *    rich descendant it wraps (a LINKED image `[![](img)](url)` follows the link,
 *    not the lightbox). It navigates via its NATIVE default action / own handler,
 *    so the reference must do nothing and must NOT `preventDefault`, or the inner
 *    link's navigation dies with it.
 *  - `'rich'`: non-anchor interactive/media content NOT wrapped in a link. It
 *    handled its own click (lightbox / play / button), so the reference suppresses
 *    its OWN navigation (`preventDefault`) but doesn't open the target.
 *  - `null`: plain content — the reference navigates to its target.
 */
export const classifyReferenceClick = (event: MouseEvent): 'anchor' | 'rich' | null => {
  const { target, currentTarget } = event
  if (!(target instanceof Element)) return null
  let rich = false
  for (let el: Element | null = target; el && el !== currentTarget; el = el.parentElement) {
    // An enclosing link owns the click even when a rich descendant (the linked
    // image) sits closer to the target — keep walking past the rich match to see
    // if a link wraps it.
    if (el.matches('a[href]')) return 'anchor'
    if (!rich && el.matches(RICH_CONTENT_SELECTOR)) rich = true
  }
  return rich ? 'rich' : null
}

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
        // Classify FIRST — whatever sits under the click owns it, modified click
        // or not. A nested link navigates natively (do nothing — NOT
        // preventDefault, or its nav dies too, in this tab or a new one). Other
        // rich content (an image's lightbox, video controls) ALREADY ran its own
        // handler on the bubble up and we can't un-run it, so the reference must
        // suppress its OWN navigation EVEN on a modified click — otherwise a
        // cmd-click fires the lightbox AND opens the target in a new tab (the
        // reference's own `<a href>` is the nearest anchor). Only plain content,
        // with no owner, reaches the opener; `openBlock` reads the modifier itself
        // (cmd/ctrl → new tab, shift/alt → new panel/window) so a modified click
        // on the link's text/chrome still opens the target out-of-place.
        const owner = classifyReferenceClick(event)
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
    </a>
  )
}
