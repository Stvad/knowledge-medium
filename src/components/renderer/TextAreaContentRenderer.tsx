import { BlockRendererProps, SelectionState } from '@/types.ts'
import { useIsEditing } from '@/data/properties.ts'
import { KeyboardEvent, ClipboardEvent, useRef, useEffect, useState, useCallback } from 'react'
import { nextVisibleBlock, previousVisibleBlock, Block } from '@/data/block.ts'
import { useUIStateProperty } from '@/data/globalState'
import { updateText } from '@automerge/automerge/next'
import { debounce } from 'lodash'
import { useRepo } from '@/context/repo'
import { pasteMultilineText } from '@/utils/paste.ts'

const splitBlockAtCursor = async (block: Block, textarea: HTMLTextAreaElement, isTopLevel: boolean) => {
  const beforeCursor = textarea.value.slice(0, textarea.selectionStart)
  const afterCursor = textarea.value.slice(textarea.selectionStart)

  if (isTopLevel) {
    const child = await block.createChild({data: {content: afterCursor}, position: 'first'})

    block.change(b => {
      b.content = beforeCursor
    })

    return child
  } else {
    // todo better undo/redo for this
    await block.createSiblingAbove({content: beforeCursor})

    block.change(b => {
      b.content = afterCursor
    })

    // Reset selection to start
    textarea.selectionStart = 0
    textarea.selectionEnd = 0
    return block
  }
}

export function TextAreaContentRenderer({block}: BlockRendererProps) {
  const repo = useRepo()
  const blockData = block.use()
  const [localContent, setLocalContent] = useState(blockData?.content || '')
  const [, setIsEditing] = useIsEditing()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [focusedBlockId, setFocusedBlockId] = useUIStateProperty<string | undefined>('focusedBlockId')
  const [selection, setSelection] = useUIStateProperty<SelectionState>('selection')
  const [topLevelBlockId] = useUIStateProperty<string>('topLevelBlockId')
  const [isCollapsed] = block.useProperty<boolean>('system:collapsed', false)
  const isTopLevel = block.id === topLevelBlockId

  useEffect(() => {
    if (focusedBlockId === block.id && textareaRef.current) {
      textareaRef.current.focus()

      // Restore selection
      if (selection?.blockId === block.id) {
        textareaRef.current.setSelectionRange(selection.start, selection.end || null)
      }
    }
    // We deliberately don't have selections as a dependency, as we only want to update it manually when we re-mount
    // cases like indent/outdent or shift up/down
  }, [focusedBlockId, block.id])

  const fitSizeToContent = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '1.7em'
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
    }
  }

  useEffect(() => {
    fitSizeToContent()
  }, [])

  // Update local content when block content changes
  useEffect(() => {
    if (blockData?.content !== undefined) {
      setLocalContent(blockData.content)
    }
  }, [blockData?.content])

  const debouncedSetSelection = useCallback(
    debounce((selection: SelectionState) => {
      setSelection(selection)
    }, 150),
    [setSelection],
  )

  const debouncedUpdateBlock = useCallback(
    debounce((value: string) => {
      block.change(b => {
        updateText(b, ['content'], value)
      })
    }, 300, {leading: true, trailing: true, maxWait: 600}),
    [block],
  )

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      debouncedUpdateBlock.flush()
      debouncedSetSelection.flush()
    }
  }, [debouncedUpdateBlock, debouncedSetSelection])

  if (!blockData) return null

  const handleKeyDown = async (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const textarea = e.target as HTMLTextAreaElement
    if (e.key === 'Escape') {
      e.stopPropagation()
      setIsEditing(false)
    }
    if (e.key === 'ArrowUp') {
      e.stopPropagation()

      if (textarea && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        e.preventDefault()
        const prevVisible = await previousVisibleBlock(block, topLevelBlockId!)
        if (prevVisible) {
          setFocusedBlockId(prevVisible.id)
        }
      }
    }
    if (e.key === 'ArrowDown') {
      e.stopPropagation()

      if (textarea &&
        textarea.selectionStart === textarea.value.length &&
        textarea.selectionEnd === textarea.value.length) {
        e.preventDefault()
        const nextVisible = await nextVisibleBlock(block, topLevelBlockId!)
        if (nextVisible) setFocusedBlockId(nextVisible.id)
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.stopPropagation()
      e.preventDefault()

      // Case 1: Cursor is in middle of text
      if (textarea.selectionStart < textarea.value.length) {
        const blockInFocus = await splitBlockAtCursor(block, textarea, isTopLevel)
        setFocusedBlockId(blockInFocus.id)
      }
      // Case 2: Cursor is at end of text and block has children
      else if (textarea.selectionStart === textarea.value.length &&
        (blockData.childIds.length > 0 && !isCollapsed || isTopLevel)) {
        const newBlock = await block.createChild({position: 'first'})
        if (newBlock) setFocusedBlockId(newBlock.id)
      }
      // Case 3: Cursor at end, no children or they are collapsed
      else {
        // todo focus logic breaks when we undo new block creation
        const newBlock = await block.createSiblingBelow()
        if (newBlock) setFocusedBlockId(newBlock.id)
      }
    } else if (e.key === 'Backspace' && blockData.content === '') {
      e.stopPropagation()
      e.preventDefault()
      const prevVisible = await previousVisibleBlock(block, topLevelBlockId!)
      block.delete()

      if (prevVisible) {
        setFocusedBlockId(prevVisible.id)
      }
    } else if (e.key === 'Tab') {
      e.stopPropagation()
      e.preventDefault()
      if (e.shiftKey) {
        block.outdent()
      } else {
        block.indent()
      }
    } else if (e.key === 'ArrowUp' && e.metaKey && e.shiftKey) {
      e.stopPropagation()
      e.preventDefault()
      block.changeOrder(-1)
    } else if (e.key === 'ArrowDown' && e.metaKey && e.shiftKey) {
      e.stopPropagation()
      e.preventDefault()
      block.changeOrder(1)
    }
  }

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    const pastedText = e.clipboardData?.getData('text/plain')
    // todo Shift modifier for pasting whole thing into the block

    if (pastedText?.includes('\n')) {
      e.preventDefault()
      const pasted = await pasteMultilineText(pastedText, block, repo)
      if (pasted[0]) {
        setFocusedBlockId(pasted[0].id)
      }
    }
  }

  return (
    <textarea
      ref={textareaRef}
      value={localContent}
      onChange={(e) => {
        const newValue = e.target.value
        setLocalContent(newValue)
        fitSizeToContent()
        debouncedUpdateBlock(newValue)
      }}
      onSelect={() => {
        if (textareaRef.current) {
          const {selectionStart, selectionEnd} = textareaRef.current
          debouncedSetSelection({
            blockId: block.id,
            start: selectionStart,
            end: selectionEnd,
          })
        }
      }}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      className={`w-full resize-none min-h-[1.7em] bg-transparent dark:bg-neutral-800 border-none p-0 font-inherit focus-visible:outline-none block-content overflow-x-hidden overflow-wrap-break-word`}
      onBlur={() => {
        debouncedUpdateBlock.flush()
        debouncedSetSelection.flush()

        if (document.hasFocus()) {
          // true means we focused somewhere else in the app,
          // false would mean we clicked outside the app, alt-tabbed, etc
          // in which case we don't want to exit insert mode plausibly
          // motivating example is emoji picker
          setIsEditing(false)
        }
      }}
    />
  )
}
