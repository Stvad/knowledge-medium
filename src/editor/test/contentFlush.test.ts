// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { acceptCompletionInsert, editorContentFlushFacet } from '@/editor/contentFlush'

/** A view whose flush records the doc and cursor it saw, the way
 *  BlockEditor's debounced `setContent` would persist them. */
const flushRecordingView = (doc: string) => {
  const flushed: {doc: string; head: number}[] = []
  const view: EditorView = new EditorView({
    state: EditorState.create({
      doc,
      extensions: editorContentFlushFacet.of(() => {
        flushed.push({doc: view.state.doc.toString(), head: view.state.selection.main.head})
      }),
    }),
  })
  return {view, flushed}
}

describe('acceptCompletionInsert', () => {
  it('replaces the span, puts the cursor after the insert, and flushes the result', () => {
    const {view, flushed} = flushRecordingView('ask @cla now')
    acceptCompletionInsert(view, {from: 4, to: 8, insert: '[[Clio]]'})
    expect(view.state.doc.toString()).toBe('ask [[Clio]] now')
    expect(view.state.selection.main.head).toBe(12)
    expect(flushed).toEqual([{doc: 'ask [[Clio]] now', head: 12}])
    view.destroy()
  })

  it('honours an explicit cursor past the insert', () => {
    const {view, flushed} = flushRecordingView('[[ab]] x')
    acceptCompletionInsert(view, {from: 2, to: 4, insert: 'abc'}, 2 + 'abc'.length + 2)
    expect(view.state.doc.toString()).toBe('[[abc]] x')
    expect(view.state.selection.main.head).toBe(7)
    expect(flushed).toEqual([{doc: '[[abc]] x', head: 7}])
    view.destroy()
  })
})
