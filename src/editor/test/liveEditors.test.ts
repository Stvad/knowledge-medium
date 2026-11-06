// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { liveEditorFor, liveEditorRegistration } from '../liveEditors'

const mount = (blockId: string) => new EditorView({
  state: EditorState.create({extensions: liveEditorRegistration(blockId)}),
  parent: document.body,
})

describe('liveEditorFor', () => {
  it('finds the editor mounted for the block, and forgets it once destroyed', () => {
    const view = mount('block-a')
    expect(liveEditorFor('block-a')).toBe(view)
    expect(liveEditorFor('block-b')).toBeUndefined()

    view.destroy()
    expect(liveEditorFor('block-a')).toBeUndefined()
  })

  it('prefers the most recently mounted of two editors for one block', () => {
    const first = mount('block-a')
    const second = mount('block-a')
    try {
      expect(liveEditorFor('block-a')).toBe(second)
      second.destroy()
      expect(liveEditorFor('block-a')).toBe(first)
    } finally {
      first.destroy()
      second.destroy()
    }
  })

  it('prefers the editor the user is in over a more recently mounted one', () => {
    const focused = mount('block-a')
    const other = mount('block-a')
    try {
      focused.focus()
      expect(liveEditorFor('block-a')).toBe(focused)
    } finally {
      focused.destroy()
      other.destroy()
    }
  })
})
