import { BlockRendererProps } from '@/types.ts'
import { useIsEditing, focusedBlockIdProp, selectionProp } from '@/data/properties.ts'
import Markdown from 'react-markdown'
import { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm'
import { useUIStateProperty } from '@/data/globalState'
import { useRef, MouseEvent, TouchEvent } from 'react'
import { useData } from '@/data/block.ts'
import { remarkTimestamps } from '@/markdown/remark-timestamps.ts'
import VideoTimeStamp from '@/components/markdown/VideoTimeStamp.tsx'
import { useBlockContext } from '@/context/block.tsx'

function getOffsetRelativeToParent(parent: HTMLElement, targetNode: Node, offset: number): number {
  let totalOffset = 0
  const walker = document.createTreeWalker(
    parent,
    NodeFilter.SHOW_TEXT,
    null,
  )

  let node: Node | null = walker.nextNode()
  while (node) {
    if (node === targetNode) {
      return totalOffset + offset
    }
    totalOffset += node.textContent?.length || 0
    node = walker.nextNode()
  }
  return totalOffset
}

// Find the text node and offset at a specific point
const getTextNodeAtPoint = (element: HTMLElement, x: number, y: number): { node: Node | null, offset: number } => {
  // Try to use caretPositionFromPoint if available (more accurate)
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y)
    if (position) {
      return {node: position.offsetNode, offset: position.offset}
    }
  }

  // Fallback to caretRangeFromPoint
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y)
    if (range) {
      return {node: range.startContainer, offset: range.startOffset}
    }
  }

  // If all else fails, return the first text node
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null)
  const firstNode = walker.nextNode()
  return {node: firstNode, offset: 0}
}

// Get cursor location from a point in the element
const getCursorLocationFromPoint = (element: HTMLElement, x: number, y: number): number => {
  if (!element) return 0

  const {node, offset} = getTextNodeAtPoint(element, x, y)
  if (!node) return 0

  // Create a temporary selection to get the cursor location
  const selection = window.getSelection()
  if (!selection) return 0

  // Create our temporary selection
  selection.removeAllRanges()
  const range = document.createRange()
  range.setStart(node, offset)
  range.setEnd(node, offset)
  selection.addRange(range)

  // Original implementation saved and restored the selection, but I don't think we need to do that

  return getOffsetRelativeToParent(element, node, offset)
}

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
  const [, setIsEditing] = useIsEditing()
  const [, setFocusedBlockId] = useUIStateProperty(focusedBlockIdProp)
  const [, setSelection] = useUIStateProperty(selectionProp)
  const blockContext = useBlockContext()
  const ref = useRef<HTMLDivElement>(null)

  const activateEditing = (cursorLocation: number) => {
    setIsEditing(true)
    setFocusedBlockId(block.id)
    setSelection({blockId: block.id, start: cursorLocation, end: cursorLocation})
  }

  const handleMouseDoubleClick = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (ref.current) {
      const cursorLocation = getCursorLocationFromPoint(ref.current, e.clientX, e.clientY)
      activateEditing(cursorLocation)
    }
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
    if (!touchStartRef.current || !ref.current || e.changedTouches.length === 0) return

    const touch = e.changedTouches[0]
    const touchEnd = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
    }

    if (!isSwipe(touchEnd, touchStartRef.current)) {
      const cursorLocation = getCursorLocationFromPoint(ref.current, touch.clientX, touch.clientY)
      activateEditing(cursorLocation)
    }

    // Reset the touch start reference
    touchStartRef.current = null
  }

  if (!blockData) return null

  /**
   * Todo the timestamp plugin should not be passed here directly, instead we need a mechanism to configure plugins
   * for a given context. In a way that can be altered by the code running inside blocks.
   *
   * The requirement of dynamic re-configuration is making for a worse mental model/we can't just assemble relevant plugins
   * I wonder if we can avoid such requirements by employing hooks, so we'd run some startup code, that uses them and gets config
   */
  return (
    <div
      ref={ref}
      className="min-h-[1.7em] whitespace-pre-wrap block-content overflow-x-hidden max-w-full"
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
        remarkPlugins={[remarkGfm, ...(blockContext.videoPlayerBlockId ? [remarkTimestamps] : [])]}
        components={{
          ...(blockContext.videoPlayerBlockId ? {
            'time-stamp': ({node}) =>
              <VideoTimeStamp hms={node.properties.hms} videoBlockId={blockContext.videoPlayerBlockId as string}/>,
          } : {}),
        } as ExtendedComponents}
      >
        {blockData.content}
      </Markdown>
    </div>
  )
}

// Define extended components type
type ExtendedComponents = Components & {
  'time-stamp'?: React.ComponentType<{
    node: any;
    [key: string]: any;
  }>;
};
