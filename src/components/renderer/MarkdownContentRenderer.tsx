import { BlockRendererProps, SelectionState } from '@/types.ts'
import { useIsEditing } from '@/data/properties.ts'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useUIStateProperty } from '@/data/globalState'
import { useRef } from 'react'

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

/**
 * Defaults to 0, doesn't handle formatting
 * @param element
 */
const getCursorLocation = (element: HTMLDivElement | null) => {
  const selection = window.getSelection()
  if (!element || !selection?.rangeCount) {
    return 0
  }
  const range = selection.getRangeAt(0)
  return getOffsetRelativeToParent(
    element,
    range.startContainer,
    range.startOffset,
  )
}

export function MarkdownContentRenderer({block}: BlockRendererProps) {
  const blockData = block.use()
  const [, setIsEditing] = useIsEditing(block)
  const [, setFocusedBlockId] = useUIStateProperty<string>('focusedBlockId')
  const [, setSelection] = useUIStateProperty<SelectionState>('selection')
  const ref = useRef<HTMLDivElement>(null)

  if (!blockData) return null

  return (
    <div
      ref={ref}
      className="min-h-[1.7em] whitespace-pre-wrap"
      onClick={() => {
        setFocusedBlockId(block.id)

      }}
      onMouseDownCapture={(e) => {
        if (e.detail !== 2) { // Double click, using this vs dblclick because want to prevent behavior of selecting text
          return
        }

        e.preventDefault()
        e.stopPropagation()

        setIsEditing(true)
        setFocusedBlockId(block.id)

        const cursorLocation = getCursorLocation(ref.current)
        setSelection({blockId: block.id, start: cursorLocation, end: cursorLocation})
      }}
    >
      <Markdown remarkPlugins={[remarkGfm]}>
        {blockData.content}
      </Markdown>
    </div>
  )
}
