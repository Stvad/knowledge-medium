import { BlockRendererProps } from '@/types.ts'
import { useIsEditing, focusedBlockIdProp, editorSelection } from '@/data/properties.ts'
import Markdown from 'react-markdown'
import { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useUIStateProperty } from '@/data/globalState'
import { useRef, MouseEvent, TouchEvent, ComponentType } from 'react'
import { useData } from '@/data/block.ts'
import { remarkTimestamps } from '@/markdown/remark-timestamps.ts'
import VideoTimeStamp from '@/components/markdown/VideoTimeStamp.tsx'
import { useBlockContext } from '@/context/block.tsx'

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
  const [, setSelection] = useUIStateProperty(editorSelection)
  const blockContext = useBlockContext()

  const activateEditing = (coords: { x: number, y: number }) => {
    setIsEditing(true)
    setFocusedBlockId(block.id)
    setSelection({blockId: block.id, ...coords})
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

  /**
   * Todo the timestamp plugin should not be passed here directly, instead we need a mechanism to configure plugins
   * for a given context. In a way that can be altered by the code running inside blocks.
   *
   * The requirement of dynamic re-configuration is making for a worse mental model/we can't just assemble relevant plugins
   * I wonder if we can avoid such requirements by employing hooks, so we'd run some startup code, that uses them and gets config
   */
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
  'time-stamp'?: ComponentType<{
    node: {properties: {hms: string}}
    [key: string]: unknown;
  }>;
};
