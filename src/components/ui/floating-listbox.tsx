import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils.ts'

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

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

const placementStyle = (
  anchor: HTMLElement,
  {
    minWidth,
    maxWidth,
    minHeight,
    maxHeight,
    viewportMargin,
    gap,
  }: FloatingListboxPlacementOptions,
): CSSProperties => {
  const rect = anchor.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const maxUsableWidth = Math.max(0, viewportWidth - viewportMargin * 2)
  const usableMinWidth = Math.min(minWidth, maxUsableWidth)
  const width = Math.min(Math.max(rect.width, usableMinWidth), maxWidth, maxUsableWidth)
  const maxLeft = Math.max(viewportMargin, viewportWidth - width - viewportMargin)
  const left = clamp(rect.left, viewportMargin, maxLeft)

  const spaceBelow = viewportHeight - rect.bottom - viewportMargin
  const spaceAbove = rect.top - viewportMargin
  const openAbove = spaceBelow < minHeight * 1.5 && spaceAbove > spaceBelow
  const maxUsableHeight = Math.max(0, viewportHeight - viewportMargin * 2)
  const usableMinHeight = Math.min(minHeight, maxUsableHeight)
  const availableHeight = Math.max(
    usableMinHeight,
    openAbove ? spaceAbove - gap : spaceBelow - gap,
  )
  const listboxMaxHeight = Math.min(maxHeight, availableHeight, maxUsableHeight)
  const maxTop = Math.max(viewportMargin, viewportHeight - listboxMaxHeight - viewportMargin)
  const top = openAbove
    ? clamp(rect.top - listboxMaxHeight - gap, viewportMargin, maxTop)
    : clamp(rect.bottom + gap, viewportMargin, maxTop)

  return {
    left,
    top,
    width,
    maxHeight: listboxMaxHeight,
  }
}

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
  const [viewportVersion, setViewportVersion] = useState(0)

  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined

    const refresh = () => setViewportVersion(version => version + 1)
    window.addEventListener('resize', refresh)
    window.addEventListener('scroll', refresh, true)
    return () => {
      window.removeEventListener('resize', refresh)
      window.removeEventListener('scroll', refresh, true)
    }
  }, [open])

  if (!open || !anchorElement || typeof document === 'undefined' || typeof window === 'undefined') return null

  void viewportVersion

  return createPortal(
    <div
      id={id}
      role={role}
      className={cn(
        'fixed z-[1000] overflow-auto rounded-md border border-border bg-popover p-1 text-sm shadow-lg',
        className,
      )}
      style={placementStyle(anchorElement, {
        minWidth,
        maxWidth,
        minHeight,
        maxHeight,
        viewportMargin,
        gap,
      })}
    >
      {children}
    </div>,
    document.body,
  )
}
