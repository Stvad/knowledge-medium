// @vitest-environment happy-dom
import { completionStatus, snippet, startCompletion } from '@codemirror/autocomplete'
import { describe, expect, it, vi } from 'vitest'
import { ExtensionEditor } from '@/components/renderer/CodeMirrorExtensionBlockRenderer.tsx'
import { docOf as doc, press, setupBlockUi } from './sourceEditorFixture.tsx'

const SOURCE = 'const alpha = 1\nalp'

vi.mock('@/components/Login.tsx', () => ({useUser: () => ({id: 'user-1', name: 'Alice'})}))

describe('the extension source editor keeps the keys it acts on', () => {
  const {openEditorAt, reachedWindow} = setupBlockUi(SOURCE)
  const open = (caret: number) => openEditorAt(ExtensionEditor, caret)

  it.each<[string, KeyboardEventInit]>([
    ['Enter', {}],
    ['Shift+Enter', {shiftKey: true}],
  ])('%s adds a line and stays in the editor', async (_name, init) => {
    const view = await open(5)
    press(view, 'Enter', init)
    expect(doc(view)).toBe('const\n  alpha = 1\nalp')
    expect(reachedWindow()).toEqual([])
  })

  it('Tab and Shift+Tab re-indent the line and stay in the editor', async () => {
    const view = await open(0)
    press(view, 'Tab')
    expect(doc(view)).toBe(`  ${SOURCE}`)
    press(view, 'Tab', {shiftKey: true})
    expect(doc(view)).toBe(SOURCE)
    expect(reachedWindow()).toEqual([])
  })

  it.each([
    ['Backspace', 'mid-source', 5, 'cons alpha = 1\nalp'],
    ['Backspace', 'at the start', 0, SOURCE],
    ['Delete', 'mid-source', 5, 'constalpha = 1\nalp'],
    ['Delete', 'at the end', SOURCE.length, SOURCE],
  ])('%s %s only edits the source', async (key, _where, caret, after) => {
    const view = await open(caret)
    press(view, key)
    expect(doc(view)).toBe(after)
    expect(reachedWindow()).toEqual([])
  })

  // The editor's own keymap keeps deciding what a key does, ahead of the fallback.
  it('Enter accepts an open completion instead of adding a line', async () => {
    const view = await open(SOURCE.length)
    startCompletion(view)
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'))
    // CodeMirror ignores an accept for 75ms after the list opens.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_000)
    press(view, 'Enter')
    expect(doc(view)).toBe('const alpha = 1\nalpha')
    expect(reachedWindow()).toEqual([])
  })

  it('Tab moves to the next snippet field instead of indenting', async () => {
    const view = await open(SOURCE.length)
    snippet('${first} ${second}')(view, null, SOURCE.length, SOURCE.length)
    const beforeTab = doc(view)
    press(view, 'Tab')
    const {main} = view.state.selection
    expect(doc(view)).toBe(beforeTab)
    expect(view.state.sliceDoc(main.from, main.to)).toBe('second')
    expect(reachedWindow()).toEqual([])
  })

  it('a chord the editor acts on does not also fire the app shortcut', async () => {
    const view = await open(0)
    press(view, 'k', {ctrlKey: true, shiftKey: true})
    expect(doc(view)).toBe('alp')
    expect(reachedWindow()).toEqual([])
  })

  it('an arrow moves the caret without also moving to another block', async () => {
    const view = await open(1)
    press(view, 'ArrowLeft')
    expect(view.state.selection.main.head).toBe(0)
    expect(reachedWindow()).toEqual([])
  })

  it.each<[string, KeyboardEventInit]>([
    ['Enter', {metaKey: true}],
    ['Enter', {altKey: true}],
    ['Escape', {}],
  ])('%s %j still reaches the app shortcuts', async (key, init) => {
    const view = await open(5)
    press(view, key, init)
    expect(reachedWindow()).toEqual([key])
  })

  it('Escape reaches the app even when the editor acts on it too', async () => {
    const view = await open(0)
    view.dispatch({selection: {anchor: 0, head: 5}})
    press(view, 'Escape')
    expect(reachedWindow()).toEqual(['Escape'])
  })
})
