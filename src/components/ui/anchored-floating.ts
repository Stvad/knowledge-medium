import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  size,
  type Placement,
  type VirtualElement,
} from '@floating-ui/dom'
import { clamp } from 'lodash-es'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
} from 'react'

export interface FloatingAnchorRect {
  bottom: number
  height: number
  left: number
  right: number
  top: number
  width: number
}

/** Optional size constraints applied by the `size` middleware. When
 *  provided, the floating element's width is matched to the anchor and
 *  clamped to `[minWidth, maxWidth]` (and the usable viewport), and its
 *  `maxHeight` is capped at `maxHeight` with a `minHeight` floor so it
 *  never collapses to nothing in a cramped gap. Omit it (the
 *  ReschedulePicker case) to leave the element's own width alone and just
 *  cap `maxHeight` at the available space. */
export interface FloatingSizing {
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
}

interface UseAnchoredFloatingOptions {
  open: boolean
  /** Live anchor element — preferred. Floating UI's `autoUpdate` tracks
   *  this element's ancestor scroll and observes its size, so the
   *  floating node stays glued to the anchor even when an inner panel
   *  (not just the window) scrolls or the anchor resizes. */
  anchorElement?: HTMLElement | null
  /** Frozen anchor rect — for callers that only have the rect from an
   *  event bridge and never the live element. Floating UI positions it as
   *  a virtual element; ancestor-scroll/resize tracking is unavailable in
   *  this mode (there's no element to observe). Ignored when
   *  `anchorElement` is set. */
  anchorRect?: FloatingAnchorRect | null
  placement?: Placement
  gap?: number
  viewportMargin?: number
  fallbackStyle?: CSSProperties
  sizing?: FloatingSizing
}

const initialFloatingStyle: CSSProperties = {
  left: 0,
  position: 'fixed',
  top: 0,
}

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export const floatingAnchorFromRect = (rect: FloatingAnchorRect): VirtualElement => ({
  // Event bridges often have only the anchor's viewport rect, not the
  // original element. Floating UI supports this via virtual elements.
  getBoundingClientRect: () => ({
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width,
    x: rect.left,
    y: rect.top,
  }),
})

export const useAnchoredFloating = ({
  open,
  anchorElement,
  anchorRect,
  placement = 'bottom',
  gap = 8,
  viewportMargin = 8,
  fallbackStyle = initialFloatingStyle,
  sizing,
}: UseAnchoredFloatingOptions) => {
  const [floatingElement, setFloatingElement] = useState<HTMLElement | null>(null)
  const [floatingStyle, setFloatingStyle] = useState<CSSProperties>(initialFloatingStyle)
  const [positioned, setPositioned] = useState(false)

  const anchor = useMemo<HTMLElement | VirtualElement | null>(
    () => anchorElement ?? (anchorRect ? floatingAnchorFromRect(anchorRect) : null),
    [anchorElement, anchorRect],
  )

  const middleware = useMemo(
    () => [
      offset(gap),
      flip({padding: viewportMargin}),
      shift({padding: viewportMargin}),
      size({
        padding: viewportMargin,
        apply: ({availableWidth, availableHeight, rects, elements}) => {
          const style = elements.floating.style
          if (sizing) {
            const {minWidth, maxWidth, minHeight = 0, maxHeight} = sizing
            if (minWidth !== undefined || maxWidth !== undefined) {
              const lower = Math.min(minWidth ?? 0, availableWidth)
              const upper = Math.min(maxWidth ?? availableWidth, availableWidth)
              style.width = `${clamp(rects.reference.width, lower, upper)}px`
            }
            // Cap at `maxHeight`, but keep a `minHeight` floor so the list
            // still has room to scroll rather than collapsing when the
            // gap is tight (matches the original FloatingListbox).
            const cap = Math.min(maxHeight ?? availableHeight, Math.max(availableHeight, minHeight))
            style.maxHeight = `${Math.max(0, cap)}px`
          } else {
            style.maxHeight = `${Math.max(0, availableHeight)}px`
          }
        },
      }),
    ],
    [gap, sizing, viewportMargin],
  )

  useIsomorphicLayoutEffect(() => {
    if (!open || !anchor || !floatingElement) {
      setPositioned(false)
      return undefined
    }

    let cancelled = false
    setPositioned(false)

    const update = () => {
      void computePosition(anchor, floatingElement, {
        middleware,
        placement,
        strategy: 'fixed',
      }).then(({x, y}) => {
        if (cancelled) return
        setFloatingStyle({
          left: x,
          position: 'fixed',
          top: y,
        })
        setPositioned(true)
      })
    }

    const cleanup = autoUpdate(anchor, floatingElement, update)
    return () => {
      cancelled = true
      cleanup()
      floatingElement.style.maxHeight = ''
      floatingElement.style.width = ''
    }
  }, [anchor, floatingElement, middleware, open, placement])

  const resolvedStyle: CSSProperties = open && anchor
    ? {
        ...floatingStyle,
        ...(positioned ? {} : {visibility: 'hidden' as const}),
      }
    : fallbackStyle

  return {
    floatingStyle: resolvedStyle,
    setFloatingElement,
  }
}
