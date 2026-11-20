import { createPortal } from 'react-dom'
import type { ComponentProps, MouseEvent as ReactMouseEvent } from 'react'
import type { Placement } from '@floating-ui/dom'
import { cn } from '@/lib/utils'
import { useAnchoredFloating, type FloatingSizing } from './anchored-floating.js'

export interface HoverHandlers {
  onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => void
  onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => void
}

/** Marks every hover card, so a gesture that runs over their anchors (block
 *  drag-and-drop) can keep them out of the way. */
export const HOVER_CARD_ATTRIBUTE = 'data-hover-card'

export interface HoverCardProps extends Omit<ComponentProps<'div'>, 'ref' | 'style'> {
  open: boolean
  anchorEl: HTMLElement | null
  /** Spread onto the card, so hovering it keeps it open. */
  hoverProps: HoverHandlers
  placement: Placement
  gap: number
  sizing?: FloatingSizing
}

/** A card floated beside an element while it is hovered, portalled to
 *  `document.body`. Rendered only while open with a live anchor. */
export function HoverCard({
  open,
  anchorEl,
  hoverProps,
  placement,
  gap,
  sizing,
  className,
  ...props
}: HoverCardProps) {
  const {floatingStyle, setFloatingElement} = useAnchoredFloating({
    open,
    anchorElement: anchorEl,
    placement,
    gap,
    viewportMargin: 8,
    sizing,
  })

  if (!open || !anchorEl || typeof document === 'undefined') return null

  return createPortal(
    <div
      {...props}
      ref={setFloatingElement}
      // Portalled to <body>, but React events still bubble through the React
      // tree to the anchor and the block shell around it, where a click would
      // focus, edit or select the underlying block. Mark the card as
      // interactive content and stop pointer/click propagation at its edge.
      // No role="tooltip": cards hold interactive links, which that role forbids.
      data-block-interaction="ignore"
      {...{[HOVER_CARD_ATTRIBUTE]: 'true'}}
      style={floatingStyle}
      onMouseEnter={hoverProps.onMouseEnter}
      onMouseLeave={hoverProps.onMouseLeave}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      className={cn('z-50 rounded-md border border-border bg-background text-foreground shadow-md', className)}
    />,
    document.body,
  )
}
