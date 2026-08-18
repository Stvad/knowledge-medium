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

  const selection = view.state.selection.main
  if (
    // Defence in depth, not load-bearing: a range that starts at the doc's end
    // (the offset clause below) cannot also extend past it, so no reachable
    // non-empty selection survives the other two clauses.
    !selection.empty ||
    selection.from !== TRIGGER_PREFIX.length ||
    view.state.doc.toString() !== TRIGGER_PREFIX
  ) {
    return false
  }
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
  // Decide BEFORE touching the live doc. Everything dispatched here is
  // persisted by the editor's own debounced commit, so a refusal discovered
  // after the dispatch cannot undo it; refusing here instead leaves the colon
  // the user actually typed exactly where it is.
  if (!await canConvertEmptyChildBlockToProperty(block, repo)) return

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
