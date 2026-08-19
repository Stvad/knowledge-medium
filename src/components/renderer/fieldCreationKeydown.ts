import { EditorView } from '@codemirror/view'
import type { BlockRendererProps } from '@/types.js'
import type { Repo } from '@/data/repo.js'
import { FIELD_FORM_MARKER } from '@/data/referenceBlock.js'
import { flushEditorContent } from '@/editor/contentFlush.js'
import {
  canConvertEmptyChildBlockToProperty,
  convertEmptyChildBlockToProperty,
} from '@/utils/propertyCreation.js'

// The trigger is the canonical field-row marker (`::`), which arrives as two
// keystrokes: the first colon inserts normally, so the doc already holds it
// when the second one fires.
const TRIGGER_PREFIX = FIELD_FORM_MARKER.slice(0, -1)
const TRIGGER_KEY = FIELD_FORM_MARKER.slice(-1)

/** Whether the document is exactly `expected` with the caret at its end — i.e.
 *  still precisely what this gesture put there, with nothing typed since. */
const docIsExactly = (view: EditorView, expected: string): boolean => {
  const selection = view.state.selection.main
  return (
    // Defence in depth, not load-bearing: a range starting at the doc's end
    // (the offset clause) cannot also extend past it, so no reachable
    // non-empty selection survives the other two clauses.
    selection.empty &&
    selection.from === expected.length &&
    view.state.doc.toString() === expected
  )
}

/** The document state this gesture owns at keydown: the marker's pending
 *  prefix, caret at its end. Re-checked once the eligibility query has
 *  awaited, because the user keeps typing through that window. */
const isTriggerState = (view: EditorView): boolean => docIsExactly(view, TRIGGER_PREFIX)

/** Hand back the whole marker the keydown suppressed half of, when the gesture
 *  declines. `left` is what this gesture last put in the document; anything
 *  else means the user typed on and the text is theirs, not ours.
 *
 *  Best effort by nature: a dispatch onto an editor that has already unmounted
 *  reaches no update listener, so a gesture abandoned in that sub-frame window
 *  keeps whatever the unmount flush persisted. Costs one character, and the
 *  alternative — writing through the repo behind the editor's back — is a
 *  second persistence path racing that same flush. */
const restoreTypedMarker = (view: EditorView, left: string): void => {
  if (!docIsExactly(view, left)) return
  view.dispatch({
    changes: {from: 0, to: left.length, insert: FIELD_FORM_MARKER},
    selection: {anchor: FIELD_FORM_MARKER.length},
  })
}

/** The `::` field-creation shortcut for CodeMirrorContentRenderer: completing a
 *  `::` in an otherwise-empty child block converts it into a property field.
 *  Guarded so it never hijacks an ordinary `::` — a doc holding anything but the
 *  pending first colon, a caret elsewhere, a modifier chord, a read-only repo,
 *  or a parentless/root block all fall through, returning false so CodeMirror
 *  inserts the character. The effect itself
 *  (`convertEmptyChildBlockToProperty`) is covered separately. */
export const handleFieldCreationKeydown = (
  event: KeyboardEvent,
  view: EditorView,
  block: BlockRendererProps['block'],
  repo: Repo,
): boolean => {
  if (
    repo.isReadOnly ||
    event.key !== TRIGGER_KEY ||
    event.defaultPrevented ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    return false
  }

  if (!isTriggerState(view)) return false
  if (!block.peek()?.parentId) return false

  event.preventDefault()
  event.stopPropagation()

  void createFieldFromTrigger(view, block, repo).catch(error => {
    console.error('[CodeMirrorContentRenderer] Failed to create property field', error)
  })

  return true
}

const createFieldFromTrigger = async (
  view: EditorView,
  block: BlockRendererProps['block'],
  repo: Repo,
): Promise<void> => {
  // Decide BEFORE touching the live doc: everything dispatched below is
  // persisted by the editor's own debounced commit, so a refusal discovered
  // afterwards could not take it back.
  const eligible = await canConvertEmptyChildBlockToProperty(block, repo)
  if (!eligible) return restoreTypedMarker(view, TRIGGER_PREFIX)

  // That query awaited, and the keystrokes kept coming — so re-read the live
  // document instead of trusting the keydown's snapshot. Anything but the bare
  // trigger means the block now holds content the clear below would wipe.
  if (!isTriggerState(view)) return

  // Drop the pending first colon and commit that now: the debounce is holding
  // it, and `tx.update` writes tombstones happily, so an unflushed `":"` would
  // land on the block the conversion is about to delete.
  view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: ''}})
  flushEditorContent(view)

  // The conversion re-checks eligibility against its own row before deleting
  // (which is what makes it safe), and this document was already cleared on
  // the strength of the earlier answer — so its refusal owes the text back
  // just as much as the first one did.
  if (!await convertEmptyChildBlockToProperty(block, repo)) restoreTypedMarker(view, '')
}

export const createFieldCreationKeydownExtension = (
  block: BlockRendererProps['block'],
  repo: Repo,
) =>
  EditorView.domEventHandlers({
    keydown: (event, view) => handleFieldCreationKeydown(event, view, block, repo),
  })
