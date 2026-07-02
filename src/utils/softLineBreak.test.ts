// @vitest-environment jsdom
import {describe, expect, test} from 'vitest'
import {EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {softLineBreakOnBeforeInput} from './codemirror'

// Regression for two iPad native-input bugs the handler owns at the beforeinput
// layer (where iOS honours preventDefault, unlike keydown):
//   • Shift+Enter double-newline: iOS WebKit applies the native `insertLineBreak`
//     twice in a contentEditable — take it over, insert exactly one break, and
//     preventDefault so no engine can double it.
//   • Plain Enter (`insertParagraph`): must never mutate the doc in this
//     single-line editor. Splitting / completion-accept is driven from the Enter
//     shortcut on the keydown layer; the native paragraph is prevented here so it
//     can't leave a stray newline or close an open completion before the
//     shortcut's completion-aware guard runs.
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

  test('insertParagraph (plain Enter) is prevented and never mutates the doc', () => {
    // The split / completion-accept happens on the keydown layer (the Enter
    // shortcut). Here we only stop the native paragraph so it can't leave a
    // stray newline or close an open completion first.
    const view = editorAt('ab', 1)
    const event = fireBeforeInput(view, 'insertParagraph')
    expect(event.defaultPrevented).toBe(true)
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
