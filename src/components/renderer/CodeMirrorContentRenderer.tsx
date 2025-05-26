import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { BlockRendererProps, SelectionState } from '@/types.ts'
import { useIsEditing, editorSelection, focusedBlockIdProp } from '@/data/properties.ts'
import { ClipboardEvent, useRef, useEffect, useMemo, useCallback } from 'react'
import { useData } from '@/data/block.ts'
import { useUIStateProperty } from '@/data/globalState'
import { updateText, getHeads, Heads } from '@automerge/automerge/next'
import { debounce } from 'lodash'
import { useRepo } from '@/context/repo'
import { pasteMultilineText } from '@/utils/paste.ts'
import { createMinimalMarkdownConfig, placeCursorAtX, placeCursorAtCoords } from '@/utils/codemirror.ts'
import { useCodeMirrorEditModeShortcuts } from '@/shortcuts/useActionContext.ts'

export function CodeMirrorContentRenderer({block}: BlockRendererProps) {
  const repo = useRepo()
  const blockData = useData(block)

  /** ---------- CodeMirror & heads tracking ---------- */
  const cm = useRef<ReactCodeMirrorRef>(null)
  const lastHeads = useRef<Heads | null>(null)          // ← NEW

  /** ---------- UI state (selection, focus) ---------- */
  const [, setIsEditing] = useIsEditing()
  const [focusedBlockId, setFocusedBlockId] = useUIStateProperty(focusedBlockIdProp)
  const initContent = useMemo(() => blockData?.content ?? '', []); // once

  const [selection, setSelection] = useUIStateProperty(editorSelection)

  const shortcutDependencies = useMemo(() => ({
    block,
    editorView: cm.current?.view,
  }), [
    block,
    cm.current?.view,
  ])

  useCodeMirrorEditModeShortcuts(shortcutDependencies, !!cm.current?.view)


  /** ---------- Debouncers ---------- */
  const pushChange = useRef(
    debounce((value: string) => {
      console.log('before push')
      block.change(b => {
        updateText(b, ['content'], value)
      })
      lastHeads.current = getHeads(block.dataSync()!)
      console.log('push', {lastHeads})
    }, 300),
  ).current

  const pushSelection = useRef(
    debounce((sel: SelectionState) => setSelection(sel), 150),
  ).current

  const flushDebouncers = useCallback(() => {
    pushChange.flush()
    pushSelection.flush()
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

    const incomingHeads = getHeads(blockData)
    // Are these heads already included in what we flushed?
    const isNew =
      !lastHeads.current ||
      incomingHeads.some(h => !lastHeads.current!.includes(h))

    if (!isNew) return                                  // self-echo; ignore
    console.debug('new remote change', incomingHeads)

    // Remote change → patch doc without rebuilding the view
    const view = cm.current.view
    const live = view.state.doc.toString()
    if (live !== blockData.content) {
      view.dispatch({
        changes: {from: 0, to: live.length, insert: blockData.content},
      })
    }
    lastHeads.current = incomingHeads                   // advance frontier
  }, [blockData])

  /** ---------- Focus & selection restoration ---------- */
  useEffect(() => {
    if (!(focusedBlockId === block.id && cm.current?.view)) return

    const view = cm.current.view
    view.focus()

    if (selection?.blockId !== block.id) return

    const end = selection.end ?? selection.start
    if (selection.x && selection.y) {
      placeCursorAtCoords(view, {x: selection.x, y: selection.y})
    } else if (selection.x) {
      placeCursorAtX(view, selection.x, selection.line === 'last')
    } else if (selection.start) {
      view.dispatch({selection: {anchor: selection.start, head: end}})
    }

  }, [focusedBlockId, block.id, cm.current?.view])


  /** ---------- Paste handler & render ---------- */
  const handlePaste = async (e: ClipboardEvent<HTMLDivElement>) => {
    e.stopPropagation()
    const text = e.clipboardData?.getData('text/plain')
    if (text?.includes('\n')) {
      e.preventDefault()
      const pasted = await pasteMultilineText(text, block, repo)
      if (pasted[0]) setFocusedBlockId(pasted[0].id)
    }
  }

  const extensions = useMemo(() => createMinimalMarkdownConfig(), [])

  if (!blockData) return null

  return (
    <div onPasteCapture={handlePaste}>
      <CodeMirror
        ref={cm}
        value={initContent}       // only initial mount; afterwards patched imperatively
        onChange={pushChange}
        onUpdate={(vu) => {
          if (vu.selectionSet) {
            const sel = vu.state.selection.main
            console.debug('updating selection', sel)
            pushSelection({blockId: block.id, start: sel.from, end: sel.to})
          }
        }}
        extensions={extensions}
        autoFocus
        className="w-full resize-none min-h-[1.7em] bg-transparent dark:bg-neutral-800 border-none p-0 font-inherit focus-visible:outline-none block-content overflow-x-hidden overflow-wrap-break-word"
        basicSetup={{
          closeBrackets: true,
          lineNumbers: false,
          foldGutter: false,
          dropCursor: false,
          allowMultipleSelections: false,
          indentOnInput: false,
          highlightSelectionMatches: false,
          searchKeymap: false,
          defaultKeymap: false,
          history: false,
          historyKeymap: false,
          highlightActiveLine: false,
          completionKeymap: false,

        }}
        indentWithTab={false}

        onBlur={() => {
          flushDebouncers()
          if (document.hasFocus()) setIsEditing(false)
        }}
      />
    </div>
  )
}
