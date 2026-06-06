import { EditorView } from '@codemirror/view'
import type { BlockRendererProps } from '@/types.js'
import type { Repo } from '@/data/repo.js'
import { convertEmptyChildBlockToProperty } from '@/utils/propertyCreation.js'

/** The `>` field-creation shortcut for CodeMirrorContentRenderer: typing `>` in
 *  an empty, top-of-doc child block converts it into a property field. Guarded
 *  so it never hijacks a normal `>` — a non-empty doc, mid-line cursor, modifier
 *  chord, read-only repo, or a parentless/root block all fall through, returning
 *  false so CodeMirror inserts the character. The effect itself
 *  (`convertEmptyChildBlockToProperty`) is covered separately. */
export const handleFieldCreationKeydown = (
  event: KeyboardEvent,
  view: EditorView,
  block: BlockRendererProps['block'],
  repo: Repo,
): boolean => {
  if (
    repo.isReadOnly ||
    event.key !== '>' ||
    event.defaultPrevented ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    return false
  }

  const selection = view.state.selection.main
  if (!selection.empty || selection.from !== 0 || view.state.doc.length !== 0) {
    return false
  }
  if (!block.peek()?.parentId) return false

  event.preventDefault()
  event.stopPropagation()

  void convertEmptyChildBlockToProperty(block, repo).catch(error => {
    console.error('[CodeMirrorContentRenderer] Failed to create property field', error)
  })

  return true
}

export const createFieldCreationKeydownExtension = (
  block: BlockRendererProps['block'],
  repo: Repo,
) =>
  EditorView.domEventHandlers({
    keydown: (event, view) => handleFieldCreationKeydown(event, view, block, repo),
  })
