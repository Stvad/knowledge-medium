import CodeMirror, { ReactCodeMirrorRef, ReactCodeMirrorProps } from '@uiw/react-codemirror'
import { EditorSelectionState } from '@/types.ts'
import { Block } from '@/data/block.ts'
import { useIsEditing, editorSelection } from '@/data/properties.ts'
import { useRef, useEffect, useMemo, useCallback, forwardRef } from 'react'
import { useUIStateBlock } from '@/data/globalState'
import { updateText, getHeads, Heads } from '@automerge/automerge/next'
import { debounce, memoize } from 'lodash'
import { placeCursorAtX, placeCursorAtCoords } from '@/utils/codemirror.ts'
import { EditorView } from '@codemirror/view'
import { useData } from '@/hooks/block.ts'

/**
 * Once per CodeMirror view
 */
const restoreFocus = memoize(async (block: Block, view: EditorView, uiStateBlock: Block) => {
  view.focus()

  const selection = (await uiStateBlock.getProperty(editorSelection))?.value

  if (selection?.blockId !== block.id) return

  if (selection?.x && selection?.y) {
    placeCursorAtCoords(view, {x: selection.x, y: selection.y})
  } else if (selection?.x) {
    placeCursorAtX(view, selection.x, selection.line === 'last')
  } else if (selection?.start) {
    const end = selection?.end ?? selection?.start
    view.dispatch({selection: {anchor: selection.start, head: end}})
  }
}, (_, view) => view)


interface BlockEditorProps extends Omit<ReactCodeMirrorProps, 'value' | 'onChange' | 'onUpdate' | 'onBlur'> {
  block: Block
}

export const BlockEditor = forwardRef<ReactCodeMirrorRef, BlockEditorProps>(({
                                                                               block,
                                                                               ...codeMirrorProps
                                                                             }, ref,
) => {
  const blockData = useData(block)
  const pendingLocalEdits = useRef(false)

  /** ---------- CodeMirror & heads tracking ---------- */
  const cm = useRef<ReactCodeMirrorRef>(null)
  const lastHeads = useRef<Heads | null>(null)

  /** ---------- UI state (selection, focus) ---------- */
  const [, setIsEditing] = useIsEditing()
  const initContent = useMemo(() => blockData?.content ?? '', [])

  const uiStateBlock = useUIStateBlock()

  /** ---------- Debouncers ---------- */
  const pushChange = useRef(
    debounce((value: string) => {
      block.change(b => {
        updateText(b, ['content'], value)
      })
      lastHeads.current = getHeads(block.dataSync()!)
      pendingLocalEdits.current = false
    }, 300),
  ).current

  const pushSelection = useRef(
    debounce((sel: EditorSelectionState) =>
        uiStateBlock.setProperty({...editorSelection, value: sel})
      , 150),
  ).current

  const flushDebouncers = useCallback(() => {
    pushChange.flush()
    pushSelection.flush()
    pendingLocalEdits.current = false
  }, [pushChange, pushSelection])

  /** ---------- Cleanup ---------- */
  useEffect(() => flushDebouncers, [flushDebouncers])

  useEffect(() => {
    if (blockData && !lastHeads.current) {
      lastHeads.current = getHeads(blockData)
    }
  }, [blockData?.id])

  /** ---------- Imperatively patch truly-remote edits ---------- */
  useEffect(() => {
    if (!blockData || !cm.current?.view) return
    if (pendingLocalEdits.current) return

    const incomingHeads = getHeads(blockData)
    // Are these heads already included in what we flushed?
    const isNew =
      !lastHeads.current ||
      incomingHeads.some(h => !lastHeads.current!.includes(h))

    if (!isNew) return // self-echo; ignore
    console.debug('new remote change', incomingHeads)

    // Remote change → patch doc without rebuilding the view
    const view = cm.current.view
    const live = view.state.doc.toString()
    if (live !== blockData.content) {
      view.dispatch({
        changes: {from: 0, to: live.length, insert: blockData.content},
        selection: view.state.selection,
      })
    }
    lastHeads.current = incomingHeads
  }, [blockData])

  if (!blockData) return null

  const forwardRefValue = (val: ReactCodeMirrorRef | null) => {
    if (ref) {
      if (typeof ref === 'function') {
        ref(val)
      } else {
        ref.current = val
      }
    }
  }

  return (
    <CodeMirror
      ref={(val) => {
        if (val?.view) restoreFocus(block, val?.view, uiStateBlock)
        cm.current = val
        forwardRefValue(val)
      }}
      value={initContent}
      onChange={(value) => {
        pendingLocalEdits.current = true
        pushChange(value)
      }}
      onUpdate={(vu) => {
        if (vu.selectionSet) {
          const sel = vu.state.selection.main
          pushSelection({blockId: block.id, start: sel.from, end: sel.to})
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
