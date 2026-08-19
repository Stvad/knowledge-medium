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

/** The document state this gesture owns: exactly the marker's pending prefix,
 *  caret at its end. Checked at keydown AND again once the eligibility query
 *  has awaited — the user keeps typing through that window, and every branch
 *  past it either clears the document or writes into it. */
const isTriggerState = (view: EditorView): boolean => {
  const selection = view.state.selection.main
  return (
    // Defence in depth, not load-bearing: a range starting at the doc's end
    // (the offset clause) cannot also extend past it, so no reachable
    // non-empty selection survives the other two clauses.
    selection.empty &&
    selection.from === TRIGGER_PREFIX.length &&
    view.state.doc.toString() === TRIGGER_PREFIX
  )
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

  // That query awaited, and the keystrokes kept coming. Re-read the LIVE doc
  // rather than trusting the keydown's snapshot: once it holds anything but
  // the bare trigger the user has typed on past the gesture, and both branches
  // below would write over that — the clear by wiping the doc whole, the
  // restore by splicing a colon into the middle of new text.
  if (!isTriggerState(view)) return

  if (!eligible) {
    // Put back the colon the keydown suppressed. The gesture declined, so the
    // block is left holding exactly what was typed rather than half of it.
    view.dispatch({
      changes: {from: TRIGGER_PREFIX.length, insert: TRIGGER_KEY},
      selection: {anchor: FIELD_FORM_MARKER.length},
    })
    return
  }

  // Drop the pending first colon and commit that now: the debounce is holding
  // it, and `tx.update` writes tombstones happily, so an unflushed `":"` would
  // land on the block the conversion is about to delete.
  view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: ''}})
  flushEditorContent(view)

  await convertEmptyChildBlockToProperty(block, repo)
}

export const createFieldCreationKeydownExtension = (
  block: BlockRendererProps['block'],
  repo: Repo,
) =>
  EditorView.domEventHandlers({
    keydown: (event, view) => handleFieldCreationKeydown(event, view, block, repo),
  })
