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
import { useRef, useEffect, useCallback, useMemo, useState, type Ref } from 'react'
import { useUIStateBlock } from '@/data/globalState'
import { debounce } from 'lodash'
import { placeCursorAtX, placeCursorAtCoords } from '@/utils/codemirror.ts'
import { useData, useDataWithSelector } from '@/hooks/block.ts'
import { shouldExitEditModeAfterBlur } from '@/utils/dom.ts'
import { EditorView } from '@codemirror/view'
import { useShortcutSurfaceActivations } from '@/extensions/blockInteractionContext.tsx'

interface BlockEditorProps extends Omit<ReactCodeMirrorProps, 'value' | 'onChange' | 'onUpdate' | 'onBlur' | 'ref'> {
  block: Block
  ref?: Ref<ReactCodeMirrorRef>
}

export const BlockEditor = ({
  block,
  ref,
  ...codeMirrorProps
}: BlockEditorProps) => {
  const blockData = useData(block)
  const pendingLocalEdits = useRef(false)
  const pendingCommittedContent = useRef<string | null>(null)

  const cm = useRef<ReactCodeMirrorRef>(null)
  const [editorView, setEditorView] = useState<EditorView | null>(null)

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

  // useRef-wrapped debounce is the per-component-instance idiom; its
  // body runs on debounce-fire (not during render), so the ref writes
  // inside are safe even though the new react-hooks rule flags the
  // closure-construction itself.
  const pushChange = useRef(
    // eslint-disable-next-line react-hooks/refs
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
    if (!blockData || !editorView) return

    const live = editorView.state.doc.toString()
    const incoming = blockData.content

    if (pendingCommittedContent.current !== null && incoming === pendingCommittedContent.current) {
      pendingCommittedContent.current = null
      pendingLocalEdits.current = false
    }

    if (pendingLocalEdits.current) return

    if (live !== incoming) {
      editorView.dispatch({
        changes: {from: 0, to: live.length, insert: incoming},
        selection: editorView.state.selection,
      })
    }
  }, [blockData, editorView])

  useEffect(() => {
    if (!isEditing || focusedBlockId !== block.id || !editorView) return

    let cancelled = false
    const frameId = requestAnimationFrame(() => {
      if (!editorView || cancelled) return

      void (async () => {
        editorView.focus()

        const selection = (await uiStateBlock.getProperty(editorSelection))?.value
        if (cancelled || selection?.blockId !== block.id) return

        if (selection.x !== undefined && selection.y !== undefined) {
          placeCursorAtCoords(editorView, {x: selection.x, y: selection.y})
        } else if (selection.x !== undefined) {
          placeCursorAtX(editorView, selection.x, selection.line === 'last')
        } else if (selection.start !== undefined) {
          const end = selection.end ?? selection.start
          editorView.dispatch({selection: {anchor: selection.start, head: end}})
        }
      })()
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(frameId)
    }
  }, [block.id, editorView, focusedBlockId, focusRequestId, isEditing, uiStateBlock])

  // Activate the EDIT_MODE_CM shortcut surface so actions bound to that
  // context (Escape, Tab, etc.) fire via hotkeys-js whenever this editor is
  // mounted — for any consumer (markdown editor, extension editor, future).
  const shortcutSurfaceOptions = useMemo(() => ({editorView: editorView ?? undefined}), [editorView])
  useShortcutSurfaceActivations('codemirror', shortcutSurfaceOptions)

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
        setEditorView(value?.view ?? null)
        forwardRefValue(value)
      }}
      // CodeMirror is uncontrolled here — we feed the *first-render*
      // content via initialContent and apply later updates by dispatching
      // changes (see the useEffect above). Reading the ref during render
      // is the deliberate uncontrolled-init pattern.
      // eslint-disable-next-line react-hooks/refs
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
}

BlockEditor.displayName = 'BlockEditor'
