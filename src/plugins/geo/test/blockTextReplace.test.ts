// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import { liveEditorRegistration } from '@/editor/liveEditors'
import { locateText, replaceBlockText } from '../blockTextReplace'

describe('locateText', () => {
  it('uses the recorded span when the trigger text is still there', () => {
    expect(locateText('met at @blue', '@blue', {from: 7, to: 12}))
      .toEqual({from: 7, to: 12})
  })

  it('re-locates the trigger text when the doc drifted around it', () => {
    // Text was prepended while the resolution was pending — the
    // recorded span no longer lines up.
    expect(locateText('yesterday we met at @blue', '@blue', {from: 7, to: 12}))
      .toEqual({from: 20, to: 25})
  })

  it('returns null when the trigger text is gone', () => {
    expect(locateText('met at home', '@blue', {from: 7, to: 12})).toBeNull()
  })

  it('returns null for an empty trigger', () => {
    expect(locateText('met at @blue', '', {from: 7, to: 7})).toBeNull()
  })
})

describe('replaceBlockText', () => {
  const run = ({isReadOnly = false} = {}) => {
    const repo = {tx: vi.fn(async () => {}), isReadOnly} as unknown as Repo
    const replaced = replaceBlockText({
      repo,
      blockId: 'b',
      locate: doc => locateText(doc, 'LINK'),
      replacement: '[[P]]',
      description: 'test',
    })
    return {repo, replaced}
  }
  const mountEditor = (doc: string, caret = 0) => new EditorView({
    state: EditorState.create({doc, selection: {anchor: caret}, extensions: liveEditorRegistration('b')}),
    parent: document.body,
  })

  it("replaces in the block's live editor, looked up at write time", async () => {
    const view = mountEditor('see LINK')
    try {
      const {repo, replaced} = run()
      expect(await replaced).toBe(true)
      expect(view.state.doc.toString()).toBe('see [[P]]')
      expect(repo.tx).not.toHaveBeenCalled()
    } finally {
      view.destroy()
    }
  })

  it('writes nothing when the live editor no longer holds the target', async () => {
    // The stored row trails the editor by its debounce and may still hold
    // the target; the editor is the authority while it's mounted.
    const view = mountEditor('see nothing')
    try {
      const {repo, replaced} = run()
      expect(await replaced).toBe(false)
      expect(repo.tx).not.toHaveBeenCalled()
    } finally {
      view.destroy()
    }
  })

  it('writes the stored row when no editor is mounted', async () => {
    mountEditor('see LINK').destroy()
    const {repo, replaced} = run()
    await replaced
    expect(repo.tx).toHaveBeenCalledTimes(1)
  })

  it('leaves the caret where the user is, mapped through the replacement', async () => {
    // A caret right after the link (an accepted completion) ends up right
    // after the replacement…
    const afterLink = mountEditor('see LINK', 8)
    try {
      expect(await run().replaced).toBe(true)
      expect(afterLink.state.selection.main.head).toBe('see [[P]]'.length)
    } finally {
      afterLink.destroy()
    }
    // …and one the user moved elsewhere while it resolved stays put.
    const elsewhere = mountEditor('see LINK', 0)
    try {
      expect(await run().replaced).toBe(true)
      expect(elsewhere.state.selection.main.head).toBe(0)
    } finally {
      elsewhere.destroy()
    }
  })

  it('writes nothing once the workspace turned read-only', async () => {
    const view = mountEditor('see LINK')
    try {
      const {repo, replaced} = run({isReadOnly: true})
      expect(await replaced).toBe(false)
      expect(view.state.doc.toString()).toBe('see LINK')
      expect(repo.tx).not.toHaveBeenCalled()
    } finally {
      view.destroy()
    }
  })
})
