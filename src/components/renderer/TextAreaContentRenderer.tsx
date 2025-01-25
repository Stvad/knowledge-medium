import { BlockRendererProps } from '@/types.ts'
import { useIsEditing } from '@/data/properties.ts'
import { KeyboardEvent, useRef, useEffect } from 'react'
import { useBlockContext } from '@/context/block.tsx'
import { nextVisibleBlock, previousVisibleBlock } from '@/data/block.ts'
import { delay } from '@/utils/async.ts'

export function TextAreaContentRenderer({block}: BlockRendererProps) {
  const blockData = block.use()
  const [_, setIsEditing] = useIsEditing(block)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { focusedBlockId, setFocusedBlockId, selection, setSelection, topLevelBlockId} = useBlockContext()

  useEffect(() => {
    /**
     * Todo: we're currently updating selection all the time, causing rerender every time, which is not ideal
     * think about this
     */
    if (focusedBlockId === block.id && textareaRef.current) {
      textareaRef.current.focus()
      if (selection?.blockId === block.id) {
        textareaRef.current.setSelectionRange(selection.start, selection.end || null)
      }
    }
  }, [focusedBlockId, selection, block.id])

  const fitSizeToContent = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '1.7em'
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
    }
  }

  useEffect(() => {
    fitSizeToContent()
  }, [])

  if (!blockData) return null


  const handleKeyDown = async (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      setIsEditing(false)
      //todo a better way, doing this to re-focus the block, so it handles kb shortcuts
      setFocusedBlockId?.(undefined)
      await delay(0)
      setFocusedBlockId?.(block.id)
    }
    /**
     * these break incapsulation now
     * also broken and don't work between hierarchy levels
     * also need to use visual first and last line
     */
    if (e.key === 'ArrowUp') {
      const textarea = textareaRef.current
      if (textarea && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        e.preventDefault()
        const prevVisible = await previousVisibleBlock(block, topLevelBlockId!)
        if (prevVisible) {

          setFocusedBlockId?.(prevVisible.id)
        }
      }
    }
    if (e.key === 'ArrowDown') {
      const textarea = textareaRef.current
      if (textarea &&
          textarea.selectionStart === textarea.value.length &&
          textarea.selectionEnd === textarea.value.length) {
        e.preventDefault()
        const nextVisible = await nextVisibleBlock(block, topLevelBlockId!)
        if (nextVisible) setFocusedBlockId?.(nextVisible.id)
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const textarea = textareaRef.current
      if (!textarea) return

      // Case 1: Cursor is in middle of text
      if (textarea.selectionStart < textarea.value.length) {
        // Split text at cursor position
        const beforeCursor = textarea.value.slice(0, textarea.selectionStart)
        const afterCursor = textarea.value.slice(textarea.selectionStart)
        
        block.change(b => {
          b.content = afterCursor
        })

        await block.createSiblingAbove({ content: beforeCursor })
        
        // Reset selection to start
        textarea.selectionStart = 0
        textarea.selectionEnd = 0
      }
      // Case 2: Cursor is at end of text and block has children
      else if (textarea.selectionStart === textarea.value.length && 
          blockData.childIds.length > 0) {
        const newBlock = await block.createChild({position: 'first'})
        if (newBlock) setFocusedBlockId?.(newBlock.id)
      }
      // Case 3: Cursor at end, no children
      else {
        const newBlock = await block.createSiblingBelow()
        if (newBlock) setFocusedBlockId?.(newBlock.id)
      }
    } else if (e.key === 'Backspace' && blockData.content === '') {
      e.preventDefault()
      const prevVisible = await previousVisibleBlock(block, topLevelBlockId!)
      block.delete()

      if (prevVisible) {
        setFocusedBlockId?.(prevVisible.id)
      }
    } else if (e.key === 'Tab') {
      e.preventDefault()
      if (e.shiftKey) {
        block.outdent()
      } else {
        block.indent()
      }
    } else if (e.key === 'ArrowUp' && e.metaKey && e.shiftKey) {
      e.preventDefault()
      block.changeOrder(-1)
    } else if (e.key === 'ArrowDown' && e.metaKey && e.shiftKey) {
      e.preventDefault()
      block.changeOrder(1)
    }
  }
  return (
    <textarea
      ref={textareaRef}
      value={blockData.content}
      onChange={(e) => {
        block.change(b => {
          b.content = e.target.value
        })
        fitSizeToContent()
      }}
      onSelect={() => {
        if (textareaRef.current) {
          const { selectionStart, selectionEnd } = textareaRef.current
          setSelection?.({
            blockId: block.id,
            start: selectionStart,
            end: selectionEnd
          })
        }
      }}
      onKeyDown={handleKeyDown}
      className={`w-full resize-none min-h-[1.7em] bg-transparent dark:bg-neutral-800 border-none p-0 font-inherit focus-visible:outline-none`}
      // onFocus={() => {
      //   setFocusedBlockId(block.id)
      //   setIsEditing(true)
      // }}
      onBlur={() => {
        setIsEditing(false)
      }}
    />
  )
}
