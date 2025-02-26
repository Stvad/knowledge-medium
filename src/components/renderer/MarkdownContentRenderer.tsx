import { BlockRendererProps, SelectionState } from '@/types.ts'
import { useIsEditing } from '@/data/properties.ts'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useUIStateProperty } from '@/data/globalState'
import { useRef, MouseEvent, TouchEvent } from 'react'

function getOffsetRelativeToParent(parent: HTMLElement, targetNode: Node, offset: number): number {
  let totalOffset = 0
  const walker = document.createTreeWalker(
    parent,
    NodeFilter.SHOW_TEXT,
    null
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
    const position = document.caretPositionFromPoint(x, y);
    if (position) {
      return { node: position.offsetNode, offset: position.offset };
    }
  }
  
  // If all else fails, return the first text node
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
  const firstNode = walker.nextNode();
  return { node: firstNode, offset: 0 };
}

// Get cursor location from a point in the element
const getCursorLocationFromPoint = (element: HTMLElement, x: number, y: number): number => {
  if (!element) return 0;
  
  const { node, offset } = getTextNodeAtPoint(element, x, y);
  if (!node) return 0;
  
  // Create a temporary selection to get the cursor location
  const selection = window.getSelection();
  if (!selection) return 0;

  // Create our temporary selection
  selection.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset);
  selection.addRange(range);

  // Original implementation saved and restored the selection, but I don't think we need to do that

  return getOffsetRelativeToParent(element, node, offset);
}

export function MarkdownContentRenderer({block}: BlockRendererProps) {
  const blockData = block.use()
  const [, setIsEditing] = useIsEditing()
  const [, setFocusedBlockId] = useUIStateProperty<string>('focusedBlockId')
  const [, setSelection] = useUIStateProperty<SelectionState>('selection')
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
      const cursorLocation = getCursorLocationFromPoint(ref.current, e.clientX, e.clientY);
      activateEditing(cursorLocation);
    }
  }
  
  const handleTouch = (e: TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (ref.current && e.changedTouches.length > 0) {
      const touch = e.changedTouches[0];
      const cursorLocation = getCursorLocationFromPoint(ref.current, touch.clientX, touch.clientY);
      activateEditing(cursorLocation);
    }
  }

  if (!blockData) return null

  return (
    <div
      ref={ref}
      className="min-h-[1.7em] whitespace-pre-wrap block-content overflow-x-hidden max-w-full"
      onClick={() => {
        setFocusedBlockId(block.id)
      }}
      onMouseDownCapture={(e) => {
        if (e.detail !== 2) { // Double click, using this vs dblclick because want to prevent behavior of selecting text
          return
        }
        handleMouseDoubleClick(e)
      }}
      onTouchEnd={handleTouch}
    >
      <Markdown remarkPlugins={[remarkGfm]}>
        {blockData.content}
      </Markdown>
    </div>
  )
}
