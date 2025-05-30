import { BlockRendererProps, EditorSelectionState } from '@/types.ts'
import { useIsEditing, editorSelection, focusedBlockIdProp } from '@/data/properties.ts'
import { ClipboardEvent, useRef, useEffect, useState, useMemo } from 'react'
import { Block } from '@/data/block.ts'
import { useUIStateProperty } from '@/data/globalState'
import { updateText } from '@automerge/automerge/next'
import { debounce } from 'lodash'
import { useRepo } from '@/context/repo'
import { pasteMultilineText } from '@/utils/paste.ts'
import { useEditModeShortcuts } from '@/shortcuts/useActionContext.ts'
import { useData } from '@/hooks/block.ts'

export const splitBlockAtCursor = async (block: Block, textarea: HTMLTextAreaElement, isTopLevel: boolean) => {
  const beforeCursor = textarea.value.slice(0, textarea.selectionStart)
  const afterCursor = textarea.value.slice(textarea.selectionStart)

  if (isTopLevel) {
    const child = await block.createChild({data: {content: afterCursor}, position: 'first'})

    block.change(b => {
      b.content = beforeCursor
    })

    return child
  } else {
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
  const blockData = useData(block)
  const [localContent, setLocalContent] = useState(blockData?.content || '')
  const [, setIsEditing] = useIsEditing()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [focusedBlockId, setFocusedBlockId] = useUIStateProperty(focusedBlockIdProp)
  const [selection, setSelection] = useUIStateProperty(editorSelection)
  const [textarea, setTextarea] = useState<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (textareaRef.current && textarea !== textareaRef.current) {
      setTextarea(textareaRef.current)
    }
  }, [textarea, textareaRef])

  // Create dependencies object for shortcuts
  const shortcutDependencies = useMemo(() => ({
    block,
    textarea: textarea!,
  }), [
    block,
    textarea,
  ])

  useEditModeShortcuts(shortcutDependencies, !!textarea)

  useEffect(() => {
    if (focusedBlockId === block.id && textareaRef.current) {
      textareaRef.current.focus()

      // Restore selection
      if (selection?.blockId === block.id && selection.start) {
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

  const debouncedSetSelection = useMemo(
    () => debounce((selection: EditorSelectionState) => {
      setSelection(selection)
    }, 150),
    [setSelection],
  )

  const debouncedUpdateBlock = useMemo(
    () => debounce((value: string) => {
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
