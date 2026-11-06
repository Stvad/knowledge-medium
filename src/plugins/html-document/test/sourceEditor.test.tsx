// @vitest-environment happy-dom
import {describe, expect, it, vi} from 'vitest'
import {docOf as doc, press, setupBlockUi} from '@/components/renderer/test/sourceEditorFixture.tsx'
import {HtmlSourceEditor} from '../HtmlDocumentContent.tsx'

const SOURCE = '<p>hi</p>'

vi.mock('@/components/Login.tsx', () => ({useUser: () => ({id: 'user-1', name: 'Alice'})}))

describe('the HTML source editor', () => {
  const {openEditorAt, reachedWindow} = setupBlockUi(SOURCE)
  const open = (caret: number) => openEditorAt(HtmlSourceEditor, caret)

  it.each<[string, KeyboardEventInit]>([
    ['Enter', {}],
    ['Shift+Enter', {shiftKey: true}],
  ])('%s adds a line and stays in the editor', async (_name, init) => {
    const view = await open('<p>'.length)
    press(view, 'Enter', init)
    expect(doc(view)).toBe('<p>\n  hi</p>')
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
    ['Backspace', 'mid-source', 1, 'p>hi</p>'],
    ['Backspace', 'at the start', 0, SOURCE],
    ['Delete', 'mid-source', 0, 'p>hi</p>'],
    ['Delete', 'at the end', SOURCE.length, SOURCE],
  ])('%s %s only edits the source', async (key, _where, caret, after) => {
    const view = await open(caret)
    press(view, key)
    expect(doc(view)).toBe(after)
    expect(reachedWindow()).toEqual([])
  })

  it.each<[string, KeyboardEventInit]>([
    ['Enter', {metaKey: true}],
    ['Enter', {ctrlKey: true}],
    ['k', {ctrlKey: true, shiftKey: true}],
    ['Escape', {}],
    ['ArrowUp', {}],
  ])('%s %j is the app\'s, and leaves the source alone', async (key, init) => {
    const view = await open(1)
    press(view, key, init)
    expect(doc(view)).toBe(SOURCE)
    expect(reachedWindow()).toEqual([key])
  })
})
