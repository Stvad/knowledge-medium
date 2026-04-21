import CodeMirror, { ReactCodeMirrorRef, ReactCodeMirrorProps } from '@uiw/react-codemirror'
import { EditorSelectionState } from '@/types.ts'
import { Block } from '@/data/block.ts'
import { useIsEditing, editorSelection } from '@/data/properties.ts'
import { useRef, useEffect, useCallback, forwardRef } from 'react'
import { useUIStateBlock } from '@/data/globalState'
import { debounce, memoize } from 'lodash'
import { placeCursorAtX, placeCursorAtCoords } from '@/utils/codemirror.ts'
import { EditorView } from '@codemirror/view'
import { useData } from '@/hooks/block.ts'

const restoreFocus = memoize(async (block: Block, view: EditorView, uiStateBlock: Block) => {
  view.focus()

  const selection = (await uiStateBlock.getProperty(editorSelection))?.value

  if (selection?.blockId !== block.id) return

  if (selection.x !== undefined && selection.y !== undefined) {
    placeCursorAtCoords(view, {x: selection.x, y: selection.y})
  } else if (selection.x !== undefined) {
    placeCursorAtX(view, selection.x, selection.line === 'last')
  } else if (selection.start !== undefined) {
    const end = selection.end ?? selection.start
    view.dispatch({selection: {anchor: selection.start, head: end}})
  }
}, (_, view) => view)

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
        if (value?.view) restoreFocus(block, value.view, uiStateBlock)
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
        if (document.hasFocus()) setIsEditing(false)
      }}
      {...codeMirrorProps}
    />
  )
})

BlockEditor.displayName = 'BlockEditor'
