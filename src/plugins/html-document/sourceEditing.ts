/** Keys that mean one thing in an outline and another in source code. In a
 *  block's editor Enter splits the block, Tab indents it, and Backspace at the
 *  start merges it into the previous one; each of those would tear an HTML
 *  document apart at the caret. */

import {indentLess, indentMore, insertNewlineAndIndent} from '@codemirror/commands'
import {ViewPlugin, type EditorView} from '@codemirror/view'

const caretAt = (view: EditorView, position: number): boolean => {
  const {main} = view.state.selection
  return main.empty && main.head === position
}

/** Whether this key is handled here. A key that only has to stay away from the
 *  block-level shortcut, Backspace at the very start, does nothing else. */
const runSourceKey = (event: KeyboardEvent, view: EditorView): boolean => {
  if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return false
  switch (event.key) {
    case 'Enter': return insertNewlineAndIndent(view)
    case 'Tab': return event.shiftKey ? indentLess(view) : indentMore(view)
    case 'Backspace': return caretAt(view, 0)
    case 'Delete': return caretAt(view, view.state.doc.length)
    default: return false
  }
}

/** Capture-phase on the editor's wrapper, ahead of CodeMirror's own listener: on
 *  iOS CodeMirror defers Enter and Backspace, which lets the real event bubble on
 *  to the window-level block shortcuts. `acceptCompletionOnEnterCapture` has the
 *  long version. */
class SourceKeysCapture {
  private readonly onKeydown = (event: KeyboardEvent) => {
    if (!runSourceKey(event, this.view)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  constructor(private readonly view: EditorView) {
    view.dom.addEventListener('keydown', this.onKeydown, true)
  }

  destroy() {
    this.view.dom.removeEventListener('keydown', this.onKeydown, true)
  }
}

export const sourceEditingKeys = ViewPlugin.fromClass(SourceKeysCapture)
