import { BlockRendererProps, EditorSelectionState } from '@/types.ts'
import { useIsEditing, editorSelection, focusedBlockIdProp } from '@/data/properties.ts'
import { ClipboardEvent, useRef, useEffect, useState, useMemo } from 'react'
import { useUIStateProperty } from '@/data/globalState'
import { debounce } from 'lodash'
import { useRepo } from '@/context/repo'
import { pasteMultilineText } from '@/utils/paste.ts'
import { useEditModeShortcuts } from '@/shortcuts/useActionContext.ts'
import { useData } from '@/hooks/block.ts'

export const splitBlockAtCursor = async (block: BlockRendererProps['block'], textarea: HTMLTextAreaElement, isTopLevel: boolean) => {
  const beforeCursor = textarea.value.slice(0, textarea.selectionStart)
  const afterCursor = textarea.value.slice(textarea.selectionStart)

  if (isTopLevel) {
    const child = await block.createChild({data: {content: afterCursor}, position: 'first'})

    block.change(b => {
      b.content = beforeCursor
    })

    return child
  }

  await block.createSiblingAbove({content: beforeCursor})

  block.change(b => {
    b.content = afterCursor
  })

  textarea.selectionStart = 0
  textarea.selectionEnd = 0
  return block
}

export function TextAreaContentRenderer({block}: BlockRendererProps) {
  const repo = useRepo()
  const blockData = useData(block)
  const [localContent, setLocalContent] = useState(blockData?.content || '')
  const pendingLocalEdits = useRef(false)
  const pendingCommittedContent = useRef<string | null>(null)
  const [, setIsEditing] = useIsEditing()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [focusedBlockId, setFocusedBlockId] = useUIStateProperty(focusedBlockIdProp)
  const [selection, setSelection] = useUIStateProperty(editorSelection)
  const selectionRef = useRef(selection)
  const previousFocusedBlockId = useRef<string | undefined>(undefined)
  const [textarea, setTextarea] = useState<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    selectionRef.current = selection
  }, [selection])

  useEffect(() => {
    if (textareaRef.current && textarea !== textareaRef.current) {
      setTextarea(textareaRef.current)
    }
  }, [textarea, textareaRef])

  const shortcutDependencies = useMemo(() => ({
    block,
    textarea: textarea!,
  }), [block, textarea])

  useEditModeShortcuts(shortcutDependencies, !!textarea)

  useEffect(() => {
    const gainedFocus = focusedBlockId === block.id && previousFocusedBlockId.current !== block.id
    previousFocusedBlockId.current = focusedBlockId

    if (!gainedFocus || !textareaRef.current) return

    textareaRef.current.focus()
    const nextSelection = selectionRef.current
    if (nextSelection?.blockId === block.id && nextSelection.start !== undefined) {
      const end = nextSelection.end ?? nextSelection.start
      textareaRef.current.setSelectionRange(nextSelection.start, end)
    }
  }, [focusedBlockId, block.id])

  const fitSizeToContent = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '1.7em'
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
    }
  }

  useEffect(() => {
    fitSizeToContent()
  }, [localContent])

  useEffect(() => {
    if (blockData?.content === undefined) return

    const incomingContent = blockData.content

    if (pendingCommittedContent.current !== null && incomingContent === pendingCommittedContent.current) {
      pendingCommittedContent.current = null
      pendingLocalEdits.current = false
    }

    if (pendingLocalEdits.current) return

    setLocalContent(currentContent =>
      currentContent === incomingContent ? currentContent : incomingContent,
    )
  }, [blockData?.content])

  const debouncedSetSelection = useMemo(
    () => debounce((nextSelection: EditorSelectionState) => {
      setSelection(nextSelection)
    }, 150),
    [setSelection],
  )

  const debouncedUpdateBlock = useMemo(
    () => debounce((value: string) => {
      pendingCommittedContent.current = value
      block.change(b => {
        b.content = value
      })
    }, 300, {leading: true, trailing: true, maxWait: 600}),
    [block],
  )

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
        pendingLocalEdits.current = true
        setLocalContent(newValue)
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
      className="w-full resize-none min-h-[1.7em] bg-transparent dark:bg-neutral-800 border-none p-0 font-inherit focus-visible:outline-none block-content overflow-x-hidden overflow-wrap-break-word"
      onBlur={() => {
        debouncedUpdateBlock.flush()
        debouncedSetSelection.flush()

        if (document.hasFocus()) {
          setIsEditing(false)
        }
      }}
    />
  )
}
