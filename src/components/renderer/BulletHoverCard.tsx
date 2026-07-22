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
  // At most one timer is ever pending: an open and a close can't be armed at
  // once (entering re-arms open only while closed; leaving arms close only
  // while open), so a single ref models the whole state machine.
  const pendingTimer = useRef<number | null>(null)

  const cancelPending = useCallback(() => {
    if (pendingTimer.current !== null) {
      window.clearTimeout(pendingTimer.current)
      pendingTimer.current = null
    }
  }, [])

  const close = useCallback(() => {
    cancelPending()
    setOpen(false)
  }, [cancelPending])

  // Mirror `enabled` into a ref, and cancel any in-flight timer the moment we
  // become disabled (mobile breakpoint crossed, plugin toggled off). Clearing
  // a timeout in an effect is a plain external-system teardown — no setState
  // here — and the ref lets a timer that somehow still fires bail instead of
  // resurrecting the card.
  const enabledRef = useRef(enabled)
  useEffect(() => {
    enabledRef.current = enabled
    if (!enabled) cancelPending()
  }, [enabled, cancelPending])

  // Reset the persisted `open` when disabled. set-state-during-render is
  // React's blessed reset-on-prop-change idiom; a reset *effect* trips the
  // cascading-render lint. Without this, an `open` that survived the disable
  // would resurface — anchored to a now-stale bullet — the instant `enabled`
  // returns true, since the exposed value is just `enabled && open`.
  const [prevEnabled, setPrevEnabled] = useState(enabled)
  if (prevEnabled !== enabled) {
    setPrevEnabled(enabled)
    if (!enabled && open) setOpen(false)
  }

  // Tidy any pending timer on unmount.
  useEffect(() => cancelPending, [cancelPending])

  const anchorHoverProps = useMemo<HoverHandlers>(() => {
    if (!enabled) return NOOP_HANDLERS
    return {
      onMouseEnter: event => {
        const el = event.currentTarget
        cancelPending()
        // Re-anchor immediately if already open (e.g. the card re-entered
        // from a neighbouring bullet); otherwise arm the open timer.
        if (open) {
          setAnchorEl(el)
          return
        }
        pendingTimer.current = window.setTimeout(() => {
          pendingTimer.current = null
          // Defense-in-depth for a real-browser jank race where the mirror
          // effect's cancelPending() is scheduled but hasn't run before this
          // timer fires. Unreachable under the tests' synchronous act(), but a
          // cheap guard for a genuinely-possible (if rare) main-thread stall.
          if (!enabledRef.current) return
          setAnchorEl(el)
          setOpen(true)
        }, OPEN_DELAY_MS)
      },
      onMouseLeave: () => {
        cancelPending()
        if (!open) return
        pendingTimer.current = window.setTimeout(() => {
          pendingTimer.current = null
          setOpen(false)
        }, CLOSE_DELAY_MS)
      },
    }
  }, [enabled, open, cancelPending])

  const cardHoverProps = useMemo<HoverHandlers>(() => {
    if (!enabled) return NOOP_HANDLERS
    return {
      onMouseEnter: () => cancelPending(),
      onMouseLeave: () => {
        cancelPending()
        pendingTimer.current = window.setTimeout(() => {
          pendingTimer.current = null
          setOpen(false)
        }, CLOSE_DELAY_MS)
      },
    }
  }, [enabled, cancelPending])

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
      // Portalled to <body>, but React events still bubble through the React
      // tree to the block shell — a click on the card would otherwise
      // focus/edit/select the underlying block. Mark it ignored (belt) and stop
      // pointer/click propagation at the boundary (suspenders). No
      // role="tooltip": the card holds interactive links, which that role
      // forbids; the mouse handlers keep the hover-intent alive.
      data-block-interaction="ignore"
      style={floatingStyle}
      onMouseEnter={hoverProps.onMouseEnter}
      onMouseLeave={hoverProps.onMouseLeave}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      className="bullet-hover-card z-50 min-w-[13rem] max-w-[20rem] rounded-md border border-border bg-background text-foreground shadow-md p-2.5"
    >
      {children}
    </div>,
    document.body,
  )
}
