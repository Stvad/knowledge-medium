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

interface UseAnchoredFloatingOptions {
  open: boolean
  anchorRect: FloatingAnchorRect | null
  placement?: Placement
  gap?: number
  viewportMargin?: number
  fallbackStyle?: CSSProperties
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
  anchorRect,
  placement = 'bottom',
  gap = 8,
  viewportMargin = 8,
  fallbackStyle = initialFloatingStyle,
}: UseAnchoredFloatingOptions) => {
  const [floatingElement, setFloatingElement] = useState<HTMLElement | null>(null)
  const [floatingStyle, setFloatingStyle] = useState<CSSProperties>(initialFloatingStyle)
  const [positioned, setPositioned] = useState(false)

  const anchor = useMemo(
    () => anchorRect ? floatingAnchorFromRect(anchorRect) : null,
    [anchorRect],
  )

  const middleware = useMemo(
    () => [
      offset(gap),
      flip({padding: viewportMargin}),
      shift({padding: viewportMargin}),
      size({
        padding: viewportMargin,
        apply: ({availableHeight, elements}) => {
          elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`
        },
      }),
    ],
    [gap, viewportMargin],
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
