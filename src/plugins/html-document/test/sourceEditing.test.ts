// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {EditorState, EditorSelection} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {sourceEditingKeys} from '../sourceEditing.ts'

describe('sourceEditingKeys', () => {
  let view: EditorView
  const reachedWindow: string[] = []
  const onWindowKey = (event: KeyboardEvent) => reachedWindow.push(event.key)

  const open = (doc: string, caret: number) => {
    view = new EditorView({
      state: EditorState.create({doc, selection: EditorSelection.single(caret), extensions: [sourceEditingKeys]}),
      parent: document.body,
    })
  }
  const press = (key: string, init: KeyboardEventInit = {}) =>
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...init}))

  beforeEach(() => {
    reachedWindow.length = 0
    window.addEventListener('keydown', onWindowKey)
  })
  afterEach(() => {
    window.removeEventListener('keydown', onWindowKey)
    view.destroy()
  })

  it('makes Enter a line break instead of letting it split the block', () => {
    open('<p>hi</p>', 3)
    press('Enter')
    expect(view.state.doc.toString()).toBe('<p>\nhi</p>')
    expect(reachedWindow).toEqual([])
  })

  it.each<[string, KeyboardEventInit, string, string]>([
    ['Tab', {}, '<p>', '  <p>'],
    ['Tab', {shiftKey: true}, '  <p>', '<p>'],
  ])('keeps %s %j inside the source', (key, init, before, after) => {
    open(before, 0)
    press(key, init)
    expect(view.state.doc.toString()).toBe(after)
    expect(reachedWindow).toEqual([])
  })

  it.each([
    ['Backspace', 'at the start', 0],
    ['Delete', 'at the end', 3],
  ])('swallows %s %s, which would merge the block with a neighbour', (key, _where, caret) => {
    open('<p>', caret)
    press(key)
    expect(view.state.doc.toString()).toBe('<p>')
    expect(reachedWindow).toEqual([])
  })

  it.each([
    ['Backspace', 1],
    ['Delete', 1],
    ['ArrowUp', 1],
    ['Escape', 1],
  ])('leaves %s away from the boundary to the app', (key, caret) => {
    open('<p>', caret)
    press(key)
    expect(reachedWindow).toEqual([key])
  })

  it('leaves a modified Enter to the app', () => {
    open('<p>', 1)
    press('Enter', {metaKey: true})
    expect(view.state.doc.toString()).toBe('<p>')
    expect(reachedWindow).toEqual(['Enter'])
  })

  it('does not treat Enter during composition as a line break', () => {
    open('<p>', 1)
    press('Enter', {isComposing: true})
    expect(view.state.doc.toString()).toBe('<p>')
  })
})
