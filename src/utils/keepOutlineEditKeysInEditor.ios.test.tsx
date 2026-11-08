// @vitest-environment happy-dom
/**
 * CodeMirror reads the platform once, at load, and on iOS defers Enter, Backspace
 * and Delete: the real keydown goes on bubbling unhandled and a non-bubbling
 * synthetic one runs the keymap later. So the platform is faked before it loads.
 */
import { cleanup, render } from '@testing-library/react'
import CodeMirror from '@uiw/react-codemirror'
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
    ['Enter', 'const\n  alpha = 1\nalp'],
    ['Backspace', 'cons alpha = 1\nalp'],
    ['Delete', 'constalpha = 1\nalp'],
  ])('%s stops at the editor, and the deferred keymap still runs', async (key, after) => {
    const view = openEditorAt(5)
    press(view, key)
    // Precondition: CodeMirror deferred the key instead of handling it now.
    expect(doc(view)).toBe(SOURCE)
    expect(reachedWindow).toEqual([])
    await vi.waitFor(() => expect(doc(view)).toBe(after))
    expect(reachedWindow).toEqual([])
  })
})
