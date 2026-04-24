import { BlockRendererProps } from '@/types.ts'
import { focusedBlockIdProp, editorSelection, isEditingProp, requestEditorFocus } from '@/data/properties.ts'
import Markdown from 'react-markdown'
import { useUIStateBlock } from '@/data/globalState'
import { useRef, MouseEvent, TouchEvent } from 'react'
import { useBlockContext } from '@/context/block.tsx'
import { useData } from '@/hooks/block.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { markdownExtensionsFacet, resolveMarkdownRenderConfig } from '@/markdown/extensions.ts'

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
  const blockData = useData(block)
  const uiStateBlock = useUIStateBlock()
  const blockContext = useBlockContext()
  const runtime = useAppRuntime()

  const activateEditing = (coords: { x: number, y: number }) => {
    uiStateBlock.setProperty({
      ...isEditingProp,
      value: true,
    })
    uiStateBlock.setProperty({
      ...focusedBlockIdProp,
      value: block.id,
    })
    uiStateBlock.setProperty({
      ...editorSelection,
      value: {blockId: block.id, ...coords},
    })
    requestEditorFocus(uiStateBlock)
  }

  const handleMouseDoubleClick = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    activateEditing({
      x: e.clientX,
      y: e.clientY,
    })
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
      activateEditing({
        x: touch.clientX,
        y: touch.clientY,
      })
    }

    // Reset the touch start reference
    touchStartRef.current = null
  }

  if (!blockData) return null
  const markdownConfig = resolveMarkdownRenderConfig(
    runtime.read(markdownExtensionsFacet),
    {block, blockContext},
  )

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
