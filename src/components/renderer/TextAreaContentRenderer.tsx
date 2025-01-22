import { BlockRendererProps, BlockData } from '@/types.ts'
import { useIsEditing } from '@/data/properties.ts'
import { KeyboardEvent, useRef, useEffect } from 'react'
import { useBlockContext } from '@/context/block.tsx'
import { AutomergeUrl } from '@automerge/automerge-repo'

export function TextAreaContentRenderer({block}: BlockRendererProps) {
  const blockData = block.use()
  const [_, setIsEditing] = useIsEditing(block)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { focusedBlockId, setFocusedBlockId, selection, setSelection } = useBlockContext()

  useEffect(() => {
    if (focusedBlockId === block.id && textareaRef.current) {
      textareaRef.current.focus()
      if (selection?.blockId === block.id) {
        textareaRef.current.setSelectionRange(selection.start, selection.end)
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
    if (e.key === 'Escape') {
      setIsEditing(false)
      setSelection?.(undefined)
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
        const parentDoc = await block.data()
        if (parentDoc?.parentId) {
          const parent = block.repo.find<BlockData>(parentDoc.parentId as AutomergeUrl)
          const parentData = await parent.doc()
          if (parentData) {
            const currentIndex = [...parentData.childIds].indexOf(block.id)
            if (currentIndex > 0) {
              const prevBlockId = parentData.childIds[currentIndex - 1]
              setFocusedBlockId?.(prevBlockId)
            }
          }
        }
      }
    }
    if (e.key === 'ArrowDown') {
      const textarea = textareaRef.current
      if (textarea &&
          textarea.selectionStart === textarea.value.length &&
          textarea.selectionEnd === textarea.value.length) {
        e.preventDefault()
        const parentDoc = await block.handle.doc()
        if (parentDoc?.parentId) {
          const parent = block.repo.find<BlockData>(parentDoc.parentId as AutomergeUrl)
          const parentData = await parent.doc()
          if (parentData) {
            const currentIndex = [...parentData.childIds].indexOf(block.id)
            if (currentIndex < parentData.childIds.length - 1) {
              const nextBlockId = parentData.childIds[currentIndex + 1]
              setFocusedBlockId?.(nextBlockId)
            }
          }
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // todo the case where we are at the end of the block and have children -> should create a new child
      e.preventDefault()
      const textarea = textareaRef.current
      if (textarea && textarea.selectionStart < textarea.value.length) {
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
      } else {
        const newBlock = await block.createSiblingBelow({})
        if (newBlock) setFocusedBlockId?.(newBlock.id)
      }
    } else if (e.key === 'Backspace' && blockData.content === '') {
      e.preventDefault()
      block.delete()
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
        setSelection?.(undefined)
      }}
    />
  )
}
