// @vitest-environment happy-dom
/**
 * CodeMirror reads the platform once, at load, and on iOS defers Enter, Backspace
 * and Delete: the real keydown goes on bubbling unhandled and a non-bubbling
 * synthetic one runs the keymap later. So the platform is faked before it loads.
 */
import { cleanup, render } from '@testing-library/react'
import CodeMirror from '@uiw/react-codemirror'
import { completionStatus, startCompletion } from '@codemirror/autocomplete'
import { javascript } from '@codemirror/lang-javascript'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keepOutlineEditKeysInEditor } from '@/utils/codemirror.js'

vi.hoisted(() => {
  Object.defineProperty(navigator, 'vendor', {value: 'Apple Computer, Inc.', configurable: true})
  Object.defineProperty(navigator, 'maxTouchPoints', {value: 5, configurable: true})
})

const SOURCE = 'const alpha = 1\nalp'
const KEY_CODES: Record<string, number> = {Enter: 13, Backspace: 8, Delete: 46}

describe('keepOutlineEditKeysInEditor under the iOS key deferral', () => {
  let reachedWindow: string[] = []
  const onWindowKey = (event: KeyboardEvent) => reachedWindow.push(event.key)

  beforeEach(() => {
    reachedWindow = []
    window.addEventListener('keydown', onWindowKey)
  })

  afterEach(() => {
    window.removeEventListener('keydown', onWindowKey)
    cleanup()
    vi.restoreAllMocks()
  })

  const openEditorAt = (caret: number): EditorView => {
    render(
      <CodeMirror
        value={SOURCE}
        extensions={[javascript({typescript: true})]}
        basicSetup={{history: false}}
        indentWithTab={true}
        onKeyDown={keepOutlineEditKeysInEditor}
      />,
    )
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-content')!)!
    view.dispatch({selection: {anchor: caret}})
    return view
  }

  const press = (view: EditorView, key: string) =>
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {key, keyCode: KEY_CODES[key], bubbles: true, cancelable: true}),
    )

  const doc = (view: EditorView) => view.state.doc.toString()

  it.each([
    ['Enter', 5, /^const\n\s*alpha = 1\nalp$/],
    ['Backspace', 5, /^cons alpha = 1\nalp$/],
    ['Delete', 5, /^constalpha = 1\nalp$/],
  ])('%s stops at the editor, and the deferred keymap still runs', async (key, caret, after) => {
    const view = openEditorAt(caret)
    press(view, key)
    // Precondition: CodeMirror deferred the key instead of handling it now.
    expect(doc(view)).toBe(SOURCE)
    expect(reachedWindow).toEqual([])
    await vi.waitFor(() => expect(doc(view)).toMatch(after))
    expect(reachedWindow).toEqual([])
  })

  it('Enter still accepts an open completion', async () => {
    const view = openEditorAt(SOURCE.length)
    startCompletion(view)
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'))
    // CodeMirror ignores an accept for 75ms after the list opens.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_000)
    press(view, 'Enter')
    expect(doc(view)).toBe(SOURCE)
    await vi.waitFor(() => expect(doc(view)).toBe('const alpha = 1\nalpha'))
    expect(reachedWindow).toEqual([])
  })
})
