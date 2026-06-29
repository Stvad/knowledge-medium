import { useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils.js'
import { useAnchoredFloating } from './anchored-floating.js'

interface FloatingListboxPlacementOptions {
  minWidth: number
  maxWidth: number
  minHeight: number
  maxHeight: number
  viewportMargin: number
  gap: number
}

interface FloatingListboxProps extends Partial<FloatingListboxPlacementOptions> {
  open: boolean
  anchorElement: HTMLElement | null
  id?: string
  role?: string
  className?: string
  children: ReactNode
}

const DEFAULT_MIN_WIDTH = 256
const DEFAULT_MAX_WIDTH = 448
const DEFAULT_MIN_HEIGHT = 96
const DEFAULT_MAX_HEIGHT = 224
const DEFAULT_VIEWPORT_MARGIN = 8
const DEFAULT_GAP = 4

/** An anchored, viewport-clamped popover list (autocomplete/picker
 *  dropdowns). Positioning is delegated to {@link useAnchoredFloating} so
 *  Floating UI's `autoUpdate` keeps it glued to the anchor when the anchor
 *  resizes or content above it reflows — cases the previous window-only
 *  tracker missed. */
export function FloatingListbox({
  open,
  anchorElement,
  id,
  role = 'listbox',
  className,
  children,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth = DEFAULT_MAX_WIDTH,
  minHeight = DEFAULT_MIN_HEIGHT,
  maxHeight = DEFAULT_MAX_HEIGHT,
  viewportMargin = DEFAULT_VIEWPORT_MARGIN,
  gap = DEFAULT_GAP,
}: FloatingListboxProps) {
  const sizing = useMemo(
    () => ({minWidth, maxWidth, minHeight, maxHeight}),
    [minWidth, maxWidth, minHeight, maxHeight],
  )
  const {floatingStyle, setFloatingElement} = useAnchoredFloating({
    open,
    anchorElement,
    gap,
    viewportMargin,
    sizing,
  })

  if (!open || !anchorElement || typeof document === 'undefined') return null

  return createPortal(
    // `pointer-events-auto` is load-bearing: when this listbox renders
    // inside a Radix Dialog (or any modal that sets `body { pointer-
    // events: none }`), the portaled element would inherit none and
    // mouse clicks on options would silently no-op. The dialog itself
    // re-enables pointer-events on its Content; we have to do the same
    // for our portaled sibling.
    <div
      id={id}
      role={role}
      ref={setFloatingElement}
      className={cn(
        'pointer-events-auto fixed z-[1000] overflow-auto rounded-md border border-border bg-popover p-1 text-sm shadow-lg',
        className,
      )}
      style={floatingStyle}
    >
      {children}
    </div>,
    document.body,
  )
}
