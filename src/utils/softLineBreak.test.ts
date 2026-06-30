// @vitest-environment jsdom
import {describe, expect, test} from 'vitest'
import {EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {softLineBreakOnBeforeInput} from './codemirror'

// Regression for the iPad Shift+Enter double-newline bug: iOS WebKit applies a
// native `insertLineBreak` twice in a contentEditable. Our handler must take it
// over and insert exactly one break (and preventDefault so the engine can't
// double it). insertParagraph (plain Enter / block split) must be left alone.
const editorAt = (doc: string, cursor: number) => {
  const view = new EditorView({
    state: EditorState.create({doc, extensions: [softLineBreakOnBeforeInput]}),
  })
  view.dispatch({selection: {anchor: cursor}})
  return view
}

const fireBeforeInput = (view: EditorView, inputType: string) => {
  const event = new InputEvent('beforeinput', {inputType, bubbles: true, cancelable: true})
  view.contentDOM.dispatchEvent(event)
  return event
}

describe('softLineBreakOnBeforeInput', () => {
  test('insertLineBreak inserts ONE line break and prevents the native insert', () => {
    const view = editorAt('ab', 1)
    const event = fireBeforeInput(view, 'insertLineBreak')
    expect(event.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe('a\nb')
    view.destroy()
  })

  test('insertParagraph (plain Enter / block split) is left to the Enter shortcut', () => {
    const view = editorAt('ab', 1)
    const event = fireBeforeInput(view, 'insertParagraph')
    expect(event.defaultPrevented).toBe(false)
    expect(view.state.doc.toString()).toBe('ab')
    view.destroy()
  })

  test('read-only editors do not intercept the break', () => {
    const view = new EditorView({
      state: EditorState.create({doc: 'ab', extensions: [softLineBreakOnBeforeInput, EditorState.readOnly.of(true)]}),
    })
    view.dispatch({selection: {anchor: 1}})
    const event = fireBeforeInput(view, 'insertLineBreak')
    expect(event.defaultPrevented).toBe(false)
    expect(view.state.doc.toString()).toBe('ab')
    view.destroy()
  })
})
