/**
 * Alt+hover preview for internal links: holding Alt over a link (or pressing it
 * while over one) floats the target block, with its children, beside the link.
 * `BlockLink` owns this, so every internal link — block refs, aliased refs,
 * page links — gets the same preview.
 */
import { createPortal } from 'react-dom'
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { useAnchoredFloating, type FloatingSizing } from '@/components/ui/anchored-floating.js'
import { useBlockContext } from '@/context/block'
import { BlockEmbed } from './BlockEmbed'
import { BlockRefAncestorsRoot } from './cycleGuard'

const PREVIEW_KEY = 'Alt'
// Bridges the gap between the link and the (offset) card as the pointer crosses.
const CLOSE_DELAY_MS = 140
const CARD_SIZING: FloatingSizing = {maxHeight: 420}

export const LINK_PREVIEW_ATTRIBUTE = 'data-link-preview'

interface HoverHandlers {
  onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => void
  onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => void
}

export interface LinkPreviewController {
  open: boolean
  anchorEl: HTMLElement | null
  /** Spread onto the link. */
  linkHoverProps: HoverHandlers
  /** Spread onto the card, so hovering it keeps it open. */
  cardHoverProps: HoverHandlers
  close: () => void
}

export function useLinkPreview(): LinkPreviewController {
  const [open, setOpen] = useState(false)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  // The link while the pointer is over it: only then does pressing Alt open.
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
    if (!hoveredEl || open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === PREVIEW_KEY) show(hoveredEl)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
  }, [])

  return {
    open,
    anchorEl,
    linkHoverProps: {
      onMouseEnter: event => {
        const el = event.currentTarget
        setHoveredEl(el)
        if (event.altKey) show(el)
        else cancelClose()
      },
      onMouseLeave: () => {
        setHoveredEl(null)
        scheduleClose()
      },
    },
    cardHoverProps: {
      onMouseEnter: () => cancelClose(),
      onMouseLeave: () => scheduleClose(),
    },
    close,
  }
}

/** The floating card: the target rendered as an embed, read-only. */
export function LinkPreviewCard({blockId, controller}: {
  blockId: string
  controller: LinkPreviewController
}) {
  const {open, anchorEl, cardHoverProps} = controller
  const blockContext = useBlockContext()
  const {floatingStyle, setFloatingElement} = useAnchoredFloating({
    open,
    anchorElement: anchorEl,
    placement: 'bottom-start',
    gap: 4,
    viewportMargin: 8,
    sizing: CARD_SIZING,
  })

  if (!open || !anchorEl || typeof document === 'undefined') return null

  const sourceBlockId = typeof blockContext.scopeRootId === 'string' ? blockContext.scopeRootId : blockId

  return createPortal(
    <div
      ref={setFloatingElement}
      // Marks everything inside as interactive content, so the block shells in
      // the preview never take a click as click-to-edit: the preview is
      // read-only. Pointer/click propagation stops here because React bubbles
      // portal events through the React tree, to the link and the source block.
      data-block-interaction="ignore"
      {...{[LINK_PREVIEW_ATTRIBUTE]: blockId}}
      style={floatingStyle}
      onMouseEnter={cardHoverProps.onMouseEnter}
      onMouseLeave={cardHoverProps.onMouseLeave}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      className="link-preview z-50 w-[28rem] max-w-[calc(100vw-16px)] overflow-auto rounded-md border border-border bg-background text-foreground shadow-md p-2"
    >
      {/* A preview is opened by hand, one level per gesture, so it starts a
          fresh cycle chain: the reference the link sits in has already
          claimed this target. */}
      <BlockRefAncestorsRoot>
        <BlockEmbed blockId={blockId} sourceBlockId={sourceBlockId} occurrenceId="link-preview" className="blockembed"/>
      </BlockRefAncestorsRoot>
    </div>,
    document.body,
  )
}
