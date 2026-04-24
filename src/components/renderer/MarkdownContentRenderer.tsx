import { BlockRendererProps } from '@/types.ts'
import { topLevelBlockIdProp } from '@/data/properties.ts'
import Markdown from 'react-markdown'
import { useInEditMode, useInFocus, useIsSelected, useUIStateBlock, useUIStateProperty } from '@/data/globalState'
import { useMemo, useRef, MouseEvent, TouchEvent } from 'react'
import { useBlockContext } from '@/context/block.tsx'
import { useData } from '@/hooks/block.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { markdownExtensionsFacet } from '@/markdown/extensions.ts'
import { useRepo } from '@/context/repo.tsx'
import { blockContentGestureHandlersFacet } from '@/extensions/blockInteraction.ts'

type Touch = { x: number; y: number; time: number }

// todo: migrate to a specialized lib for this
const isSwipe = (touchEnd: Touch, touchStart: Touch) => {
  // Calculate distance and time of the touch
  const distX = Math.abs(touchEnd.x - touchStart.x)
  const distY = Math.abs(touchEnd.y - touchStart.y)
  const elapsedTime = touchEnd.time - touchStart.time

  // If it's a tap (small movement, short duration) then go into edit mode
  // Adjust these thresholds as needed
  return distX > 10 || distY > 10 || elapsedTime > 300
}

export function MarkdownContentRenderer({block}: BlockRendererProps) {
  const repo = useRepo()
  const blockData = useData(block)
  const uiStateBlock = useUIStateBlock()
  const blockContext = useBlockContext()
  const runtime = useAppRuntime()
  const [topLevelBlockId] = useUIStateProperty(topLevelBlockIdProp)
  const inFocus = useInFocus(block.id)
  const inEditMode = useInEditMode(block.id)
  const isSelected = useIsSelected(block.id)
  const blockInteractionContext = useMemo(() => ({
    block,
    repo,
    uiStateBlock,
    topLevelBlockId,
    inFocus,
    inEditMode,
    isSelected,
    isTopLevel: block.id === topLevelBlockId,
  }), [
    block,
    repo,
    uiStateBlock,
    topLevelBlockId,
    inFocus,
    inEditMode,
    isSelected,
  ])
  const resolveContentGestureHandlers = runtime.read(blockContentGestureHandlersFacet)
  const contentGestureHandlers = resolveContentGestureHandlers(blockInteractionContext)

  const handleMouseDoubleClick = (e: MouseEvent) => {
    void contentGestureHandlers.onDoubleClick?.(e)
  }

  const touchStartRef = useRef<Touch | null>(null)

  const handleTouchStart = (e: TouchEvent) => {
    if (e.touches.length > 0) {
      const touch = e.touches[0]
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      }
    }
  }

  const handleTouchEnd = (e: TouchEvent) => {
    if (!touchStartRef.current || e.changedTouches.length === 0) return

    const touch = e.changedTouches[0]
    const touchEnd = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
    }

    if (!isSwipe(touchEnd, touchStartRef.current)) {
      void contentGestureHandlers.onTap?.(e)
    }

    // Reset the touch start reference
    touchStartRef.current = null
  }

  if (!blockData) return null
  const resolveMarkdownConfig = runtime.read(markdownExtensionsFacet)
  const markdownConfig = resolveMarkdownConfig({block, blockContext})

  return (
    <div
      className="min-h-[1.7em] whitespace-pre-wrap overflow-x-hidden max-w-full"
      onMouseDownCapture={(e) => {
        if (e.detail !== 2) { // Double click, using this vs dblclick because want to prevent behavior of selecting text
          return
        }
        handleMouseDoubleClick(e)
      }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <Markdown
        remarkPlugins={markdownConfig.remarkPlugins}
        components={markdownConfig.components}
      >
        {blockData.content}
      </Markdown>
    </div>
  )
}
