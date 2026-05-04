import CodeMirror, { ReactCodeMirrorRef, ReactCodeMirrorProps } from '@uiw/react-codemirror'
import { Block } from '../data/block'
import {
  editorSelection,
  focusedBlockIdProp,
  editorFocusRequestProp,
  type EditorSelectionState,
} from '@/data/properties.ts'
import { useRef, useEffect, useCallback, useMemo, useState, type Ref } from 'react'
import { useIsEditing, useUIStateBlock } from '@/data/globalState'
import { debounce } from 'lodash'
import { placeCursorAtX, placeCursorAtCoords } from '@/utils/codemirror.ts'
import { useContentRevision, usePropertyValue } from '@/hooks/block.ts'
import { shouldExitEditModeAfterBlur } from '@/utils/dom.ts'
import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import { useShortcutSurfaceActivations } from '@/extensions/useShortcutSurfaceActivations.ts'

interface BlockEditorProps extends Omit<ReactCodeMirrorProps, 'value' | 'onChange' | 'onUpdate' | 'onBlur' | 'ref'> {
  block: Block
  ref?: Ref<ReactCodeMirrorRef>
}

export const BlockEditor = ({
  block,
  ref,
  ...codeMirrorProps
}: BlockEditorProps) => {
  const blockEditData = useContentRevision(block)

  const cm = useRef<ReactCodeMirrorRef>(null)
  const [editorView, setEditorView] = useState<EditorView | null>(null)

  const [isEditing, setIsEditing] = useIsEditing()
  const initialContent = useRef(blockEditData?.content ?? '')
  // Last value we handed to `block.setContent` (or adopted from an
  // external change). Decides whether a `blockData` update is (a) our
  // own committed echo / a no-op (live === incoming), (b) an external
  // change we should adopt (live matches lastCommittedContent), or
  // (c) an arrival that would clobber edits the user has typed past
  // their last commit (skip; the next debounced commit reconciles).
  const lastCommittedContent = useRef(blockEditData?.content ?? '')
  // Highest `updatedAt` we've adopted from blockData. Ratchets forward
  // monotonically so a stale snapshot (older or same-ms with different
  // content) can't clobber the editor — the cache layer has its own LWW
  // gate via applySyncSnapshot, this is defense-in-depth at the React
  // layer for paths that bypass it (e.g. blockData arriving via React
  // batching after a stale-but-published snapshot).
  const lastAdoptedUpdatedAt = useRef(blockEditData?.updatedAt ?? 0)
  const uiStateBlock = useUIStateBlock()
  const [focusedBlockId] = usePropertyValue(uiStateBlock, focusedBlockIdProp)
  const [focusRequestId] = usePropertyValue(uiStateBlock, editorFocusRequestProp)

  // useRef-wrapped debounce is the per-component-instance idiom; its
  // body runs on debounce-fire (not during render), so the ref writes
  // inside are safe even though the new react-hooks rule flags the
  // closure-construction itself.
  //
  // Note: `lastCommittedContent` is NOT updated here. Doing so used to
  // open a race — between this synchronous ref write and the tx
  // actually committing, a re-render driven by a PRIOR (still in-flight)
  // commit's late notification would arrive with `incoming` = the prior
  // content but `lastCommittedContent` already optimistically advanced
  // to the value we just queued, so the "user typed past" guard
  // wouldn't trip and the editor would clobber back to the prior value.
  // Instead, the adoption useEffect advances `lastCommittedContent`
  // when it observes `live === incoming` — i.e. when the cache
  // genuinely confirms our write.
  const pushChange = useRef(
    debounce((value: string) => {
      void block.setContent(value)
    }, 300),
  ).current

  const pushSelection = useRef(
    debounce((selection: EditorSelectionState) => {
      // Skip if focus has already moved to another block. Cross-block
      // navigation actions (Up/Down/Backspace-merge) write the target
      // block's `editorSelection` and then change `focusedBlockId`; this
      // BlockEditor unmounts and `flushDebouncers` fires a pending
      // pushSelection synchronously. Without this guard that fire would
      // overwrite the navigation's selection with a stale entry pointing
      // back at this (now unfocused) block, so the new editor's focus
      // effect bails on `selection.blockId !== block.id` and the cursor
      // lands at position 0 instead of the column the user came from.
      if (uiStateBlock.peekProperty(focusedBlockIdProp) !== selection.blockId) return
      void uiStateBlock.set(editorSelection, selection)
    }, 150),
  ).current

  const flushDebouncers = useCallback(() => {
    pushChange.flush()
    pushSelection.flush()
  }, [pushChange, pushSelection])

  useEffect(() => flushDebouncers, [flushDebouncers])

  useEffect(() => {
    if (!blockEditData || !editorView) return
    // Ratchet the high-water `updatedAt` on every observation — including
    // our own committed-echoes that fall through to the early return
    // below. This is what makes the staleness check below trustworthy:
    // without it, a stale snapshot whose `updatedAt` is older than our
    // own latest commit (but newer than the previous external adoption)
    // would slip through.
    const incomingUpdatedAt = blockEditData.updatedAt
    const live = editorView.state.doc.toString()
    const incoming = blockEditData.content
    if (live === incoming) {
      // Cache has confirmed the editor's current value — either our own
      // committed write echoing back, or coincidentally identical
      // external state. Advance the "last committed" marker so the
      // user-typed-past guard below can be trusted: it can't trip on a
      // value the cache has already absorbed.
      lastCommittedContent.current = incoming
      if (incomingUpdatedAt > lastAdoptedUpdatedAt.current) {
        lastAdoptedUpdatedAt.current = incomingUpdatedAt
      }
      return
    }
    // Stale snapshot (older or equal-ms with different content). The
    // cache's LWW gate normally catches this, but a same-ms collision
    // window can squeeze a stale snapshot through to React; refuse to
    // roll back.
    if (incomingUpdatedAt <= lastAdoptedUpdatedAt.current) return
    // User has typed past the last commit — adopting `incoming` here
    // would discard those characters. Skip; the user's next debounced
    // commit will catch the editor up.
    if (live !== lastCommittedContent.current) return
    // Clamp the existing selection to the new doc length before dispatch.
    // An external change can shorten the doc below the cursor; passing the
    // raw selection then trips CodeMirror's "Selection points outside of
    // document" check. Omitting selection isn't an option either — the
    // cursor sits inside the replaced range [0, live.length], so default
    // mapping collapses it to 0.
    const newLength = incoming.length
    const oldSelection = editorView.state.selection
    const clampedSelection = EditorSelection.create(
      oldSelection.ranges.map(r =>
        EditorSelection.range(Math.min(r.anchor, newLength), Math.min(r.head, newLength)),
      ),
      oldSelection.mainIndex,
    )
    editorView.dispatch({
      changes: {from: 0, to: live.length, insert: incoming},
      selection: clampedSelection,
    })
    lastCommittedContent.current = incoming
    lastAdoptedUpdatedAt.current = incomingUpdatedAt
  }, [blockEditData, editorView, block.id])

  useEffect(() => {
    if (!isEditing || focusedBlockId !== block.id || !editorView) return

    let cancelled = false
    const frameId = requestAnimationFrame(() => {
      if (!editorView || cancelled) return

      editorView.focus()

      const selection = uiStateBlock.peekProperty(editorSelection)
      if (cancelled || selection?.blockId !== block.id) return

      if (selection.x !== undefined && selection.y !== undefined) {
        placeCursorAtCoords(editorView, {x: selection.x, y: selection.y})
      } else if (selection.x !== undefined) {
        placeCursorAtX(editorView, selection.x, selection.line === 'last')
      } else if (selection.start !== undefined) {
        const end = selection.end ?? selection.start
        editorView.dispatch({selection: {anchor: selection.start, head: end}})
      }
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
  useShortcutSurfaceActivations(block, 'codemirror', shortcutSurfaceOptions)

  if (!blockEditData) return null

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
