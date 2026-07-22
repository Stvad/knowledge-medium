/**
 * Bullet hover-card mechanics (core seam for `blockBulletHoverFacet`).
 *
 * `BlockBullet` owns the *behaviour* — hover-intent open/close, floating
 * placement, portalling — while plugins own the *content* via
 * `blockBulletHoverFacet` (a sections facet, like `blockHeaderFacet`). This
 * keeps the fiddly timer/positioning logic in one place and lets any number
 * of plugins contribute rows to the same card.
 *
 * Nothing here runs on a stock build: when the facet resolves to zero
 * sections, `BlockBullet` passes `enabled: false` and every handler below is
 * a no-op, so the bullet attaches no listeners and the card never mounts.
 */
import { createPortal } from 'react-dom'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { useAnchoredFloating } from '@/components/ui/anchored-floating.js'

// Slightly deliberate open delay so brushing past a bullet during
// navigation doesn't flash the card; a short close delay bridges the gap
// between the bullet and the (offset) card as the pointer crosses.
const OPEN_DELAY_MS = 350
const CLOSE_DELAY_MS = 140

interface HoverHandlers {
  onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => void
  onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => void
}

export interface BulletHoverController {
  /** True only while `enabled` AND the card should be visible. */
  open: boolean
  /** The bullet element the card anchors to (captured on hover). */
  anchorEl: HTMLElement | null
  /** Spread onto the bullet trigger element. */
  anchorHoverProps: HoverHandlers
  /** Spread onto the floating card so hovering it keeps the card open. */
  cardHoverProps: HoverHandlers
  /** Force-close (e.g. on bullet click / navigation). */
  close: () => void
}

const NOOP_HANDLERS: HoverHandlers = {
  onMouseEnter: () => {},
  onMouseLeave: () => {},
}

/** Hover-intent controller for the bullet metadata card. When `enabled`
 *  is false the returned handlers are inert and the card never opens
 *  (mobile, or no contributed sections), so the caller pays nothing. */
export function useBulletHover(enabled: boolean): BulletHoverController {
  const [open, setOpen] = useState(false)
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  const cancelOpen = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }, [])
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  const close = useCallback(() => {
    cancelOpen()
    cancelClose()
    setOpen(false)
  }, [cancelOpen, cancelClose])

  // Tidy any pending timers on unmount.
  useEffect(() => () => {
    cancelOpen()
    cancelClose()
  }, [cancelOpen, cancelClose])

  const anchorHoverProps = useMemo<HoverHandlers>(() => {
    if (!enabled) return NOOP_HANDLERS
    return {
      onMouseEnter: event => {
        const el = event.currentTarget
        cancelClose()
        // Re-anchor immediately if already open (e.g. the card re-entered
        // from a neighbouring bullet); otherwise arm the open timer.
        if (open) {
          setAnchorEl(el)
          return
        }
        if (openTimer.current !== null) return
        openTimer.current = window.setTimeout(() => {
          openTimer.current = null
          setAnchorEl(el)
          setOpen(true)
        }, OPEN_DELAY_MS)
      },
      onMouseLeave: () => {
        cancelOpen()
        if (!open) return
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = null
          setOpen(false)
        }, CLOSE_DELAY_MS)
      },
    }
  }, [enabled, open, cancelClose, cancelOpen])

  const cardHoverProps = useMemo<HoverHandlers>(() => {
    if (!enabled) return NOOP_HANDLERS
    return {
      onMouseEnter: () => cancelClose(),
      onMouseLeave: () => {
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = null
          setOpen(false)
        }, CLOSE_DELAY_MS)
      },
    }
  }, [enabled, cancelClose])

  return {open: enabled && open, anchorEl, anchorHoverProps, cardHoverProps, close}
}

export interface BulletHoverCardProps {
  open: boolean
  anchorEl: HTMLElement | null
  hoverProps: HoverHandlers
  children: ReactNode
}

/** Floating card portalled to `document.body`, glued to the bullet via
 *  Floating UI. Rendered only while open with a live anchor. */
export function BulletHoverCard({open, anchorEl, hoverProps, children}: BulletHoverCardProps) {
  const {floatingStyle, setFloatingElement} = useAnchoredFloating({
    open,
    anchorElement: anchorEl,
    placement: 'right-start',
    gap: 6,
    viewportMargin: 8,
  })

  if (!open || !anchorEl || typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={setFloatingElement}
      role="tooltip"
      style={floatingStyle}
      onMouseEnter={hoverProps.onMouseEnter}
      onMouseLeave={hoverProps.onMouseLeave}
      className="bullet-hover-card z-50 min-w-[13rem] max-w-[20rem] rounded-md border border-border bg-background text-foreground shadow-md p-2.5"
    >
      {children}
    </div>,
    document.body,
  )
}
