import CodeMirror, { ReactCodeMirrorRef, ReactCodeMirrorProps } from '@uiw/react-codemirror'
import { EditorSelectionState } from '@/types.ts'
import { Block } from '@/data/block.ts'
import {
  useIsEditing,
  editorSelection,
  focusedBlockIdProp,
  isEditingProp,
  editorFocusRequestProp,
} from '@/data/properties.ts'
import { useRef, useEffect, useCallback, forwardRef } from 'react'
import { useUIStateBlock } from '@/data/globalState'
import { debounce } from 'lodash'
import { placeCursorAtX, placeCursorAtCoords } from '@/utils/codemirror.ts'
import { useData, useDataWithSelector } from '@/hooks/block.ts'
import { shouldExitEditModeAfterBlur } from '@/utils/dom.ts'

interface BlockEditorProps extends Omit<ReactCodeMirrorProps, 'value' | 'onChange' | 'onUpdate' | 'onBlur'> {
  block: Block
}

export const BlockEditor = forwardRef<ReactCodeMirrorRef, BlockEditorProps>(({
  block,
  ...codeMirrorProps
}, ref) => {
  const blockData = useData(block)
  const pendingLocalEdits = useRef(false)
  const pendingCommittedContent = useRef<string | null>(null)

  const cm = useRef<ReactCodeMirrorRef>(null)

  const [, setIsEditing] = useIsEditing()
  const initialContent = useRef(blockData?.content ?? '')
  const uiStateBlock = useUIStateBlock()
  const focusedBlockId = useDataWithSelector(
    uiStateBlock,
    doc => doc?.properties[focusedBlockIdProp.name]?.value as string | undefined,
  )
  const isEditing = useDataWithSelector(
    uiStateBlock,
    doc => Boolean(doc?.properties[isEditingProp.name]?.value),
  )
  const focusRequestId = useDataWithSelector(
    uiStateBlock,
    doc => (doc?.properties[editorFocusRequestProp.name]?.value as number | undefined) ?? 0,
  )

  const pushChange = useRef(
    debounce((value: string) => {
      pendingCommittedContent.current = value
      block.change(b => {
        b.content = value
      })
    }, 300),
  ).current

  const pushSelection = useRef(
    debounce((selection: EditorSelectionState) =>
      uiStateBlock.setProperty({...editorSelection, value: selection}), 150),
  ).current

  const flushDebouncers = useCallback(() => {
    pushChange.flush()
    pushSelection.flush()
  }, [pushChange, pushSelection])

  useEffect(() => flushDebouncers, [flushDebouncers])

  useEffect(() => {
    if (!blockData || !cm.current?.view) return

    const view = cm.current.view
    const live = view.state.doc.toString()
    const incoming = blockData.content

    if (pendingCommittedContent.current !== null && incoming === pendingCommittedContent.current) {
      pendingCommittedContent.current = null
      pendingLocalEdits.current = false
    }

    if (pendingLocalEdits.current) return

    if (live !== incoming) {
      view.dispatch({
        changes: {from: 0, to: live.length, insert: incoming},
        selection: view.state.selection,
      })
    }
  }, [blockData])

  useEffect(() => {
    if (!isEditing || focusedBlockId !== block.id || !cm.current?.view) return

    let cancelled = false
    const frameId = requestAnimationFrame(() => {
      const view = cm.current?.view
      if (!view || cancelled) return

      void (async () => {
        view.focus()

        const selection = (await uiStateBlock.getProperty(editorSelection))?.value
        if (cancelled || selection?.blockId !== block.id) return

        if (selection.x !== undefined && selection.y !== undefined) {
          placeCursorAtCoords(view, {x: selection.x, y: selection.y})
        } else if (selection.x !== undefined) {
          placeCursorAtX(view, selection.x, selection.line === 'last')
        } else if (selection.start !== undefined) {
          const end = selection.end ?? selection.start
          view.dispatch({selection: {anchor: selection.start, head: end}})
        }
      })()
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(frameId)
    }
  }, [block.id, focusedBlockId, focusRequestId, isEditing, uiStateBlock])

  if (!blockData) return null

  const forwardRefValue = (value: ReactCodeMirrorRef | null) => {
    if (!ref) return

    if (typeof ref === 'function') {
      ref(value)
    } else {
      ref.current = value
    }
  }

  return (
    <CodeMirror
      ref={(value) => {
        cm.current = value
        forwardRefValue(value)
      }}
      value={initialContent.current}
      onChange={(value) => {
        pendingLocalEdits.current = true
        pushChange(value)
      }}
      onUpdate={(viewUpdate) => {
        if (viewUpdate.selectionSet) {
          const selection = viewUpdate.state.selection.main
          pushSelection({blockId: block.id, start: selection.from, end: selection.to})
        }
      }}
      onBlur={() => {
        flushDebouncers()
        requestAnimationFrame(() => {
          if (document.hasFocus() && shouldExitEditModeAfterBlur(document.activeElement)) {
            setIsEditing(false)
          }
        })
      }}
      {...codeMirrorProps}
    />
  )
})

BlockEditor.displayName = 'BlockEditor'
