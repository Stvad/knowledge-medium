/**
 * Alt+hover preview for internal links: holding Alt over a link (or pressing it
 * while over one) floats the target block, with its children, beside the link.
 * It decorates `BlockLink`, so every internal link — block refs, aliased refs,
 * page links — gets the same preview.
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { FloatingSizing } from '@/components/ui/anchored-floating.js'
import { HoverCard, type HoverHandlers } from '@/components/ui/hover-card.js'
import { useBlockContext } from '@/context/block'
import type { BlockLinkDecoratorProps } from '@/extensions/blockLinkDecorators.js'
import { BlockEmbed } from '@/components/references/BlockEmbed'
import { BlockRefAncestorsRoot } from '@/components/references/cycleGuard'
import { ExtensionRenderBoundary } from '@/extensions/ExtensionRenderBoundary.js'
import { hasEditableTarget } from '@/shortcuts/utils'

const PREVIEW_KEY = 'Alt'
// Bridges the gap between the link and the (offset) card as the pointer crosses.
const CLOSE_DELAY_MS = 140
const CARD_SIZING: FloatingSizing = {maxHeight: 420}

const LINK_ANCHOR_ATTRIBUTE = 'data-link-preview-anchor'

/** Links nest (a reference's content can hold a page link), and the innermost
 *  link under the pointer owns the preview, not every link around it. */
const ownsPointer = (event: ReactMouseEvent<HTMLElement>): boolean =>
  event.target instanceof Element &&
  event.target.closest(`[${LINK_ANCHOR_ATTRIBUTE}]`) === event.currentTarget

/** A bare Alt press: not one held down (auto-repeat), and not the start of a
 *  chord typed into an editor (Option+arrow, an Option-typed character). */
const opensPreview = (event: KeyboardEvent): boolean =>
  event.key === PREVIEW_KEY && !event.repeat && !hasEditableTarget(event)

function useLinkPreview() {
  const [open, setOpen] = useState(false)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  // The link while it owns the pointer: only then does pressing Alt open.
  const [hoveredEl, setHoveredEl] = useState<HTMLElement | null>(null)
  const closeTimer = useRef<number | null>(null)

  const cancelClose = () => {
    if (closeTimer.current === null) return
    window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const close = () => {
    cancelClose()
    setOpen(false)
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
    }, CLOSE_DELAY_MS)
  }
  const show = (el: HTMLElement) => {
    cancelClose()
    setAnchorEl(el)
    setOpen(true)
  }

  useEffect(() => {
    if (!open && !hoveredEl) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (open) {
        if (event.key !== 'Escape') return
        // The Escape that dismisses the card is spent on it: the app's own
        // Escape (leave editing, clear selection) listens later, at the bubble.
        event.stopPropagation()
        close()
      } else if (hoveredEl && opensPreview(event)) {
        show(hoveredEl)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  })

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
  }, [])

  const linkProps = {
    onMouseOver: (event: ReactMouseEvent<HTMLElement>) => {
      if (!ownsPointer(event)) {
        setHoveredEl(null)
        scheduleClose()
        return
      }
      const el = event.currentTarget
      setHoveredEl(el)
      if (event.altKey) show(el)
      else cancelClose()
    },
    onMouseLeave: () => {
      setHoveredEl(null)
      scheduleClose()
    },
  }
  const cardHoverProps: HoverHandlers = {
    onMouseEnter: () => cancelClose(),
    onMouseLeave: () => scheduleClose(),
  }
  return {open, anchorEl, linkProps, cardHoverProps, close}
}

/** The target rendered as an embed. `HoverCard` marks it as interactive
 *  content, so its blocks never take a click as click-to-edit. */
function LinkPreviewBody({blockId}: {blockId: string}) {
  const blockContext = useBlockContext()
  const sourceBlockId = typeof blockContext.scopeRootId === 'string' ? blockContext.scopeRootId : blockId
  return (
    // A preview is opened by hand, one level per gesture, so it starts a fresh
    // cycle chain: the reference the link sits in has already claimed this target.
    <BlockRefAncestorsRoot>
      <BlockEmbed blockId={blockId} sourceBlockId={sourceBlockId} occurrenceId="link-preview" peek/>
    </BlockRefAncestorsRoot>
  )
}

const chain = <E,>(first?: (event: E) => void, second?: (event: E) => void) =>
  (event: E) => {
    first?.(event)
    second?.(event)
  }

export function LinkPreviewDecorator({link, anchorProps, children}: BlockLinkDecoratorProps) {
  const preview = useLinkPreview()
  return (
    <>
      {children({
        ...anchorProps,
        ...{[LINK_ANCHOR_ATTRIBUTE]: ''},
        onMouseOver: chain(anchorProps.onMouseOver, preview.linkProps.onMouseOver),
        onMouseLeave: chain(anchorProps.onMouseLeave, preview.linkProps.onMouseLeave),
        onClick: chain(preview.close, anchorProps.onClick),
      })}
      <HoverCard
        open={preview.open}
        anchorEl={preview.anchorEl}
        hoverProps={preview.cardHoverProps}
        placement="bottom-start"
        gap={4}
        sizing={CARD_SIZING}
        data-link-preview={link.blockId}
        className="link-preview w-[28rem] max-w-[calc(100vw-16px)] overflow-auto p-2"
      >
        <ExtensionRenderBoundary>
          <LinkPreviewBody blockId={link.blockId}/>
        </ExtensionRenderBoundary>
      </HoverCard>
    </>
  )
}
