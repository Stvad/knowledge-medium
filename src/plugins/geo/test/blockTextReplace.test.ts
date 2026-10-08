// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
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
  const run = (view: EditorView) => {
    const repo = {tx: vi.fn(async () => {})} as unknown as Repo
    const replaced = replaceBlockText({
      repo,
      blockId: 'b',
      view,
      locate: doc => locateText(doc, 'LINK'),
      replacement: '[[P]]',
      description: 'test',
    })
    return {repo, replaced}
  }
  const mounted = (doc: string) => new EditorView({state: EditorState.create({doc}), parent: document.body})

  it('replaces in the mounted editor, not the stored row', async () => {
    const view = mounted('see LINK')
    try {
      const {repo, replaced} = run(view)
      expect(await replaced).toBe(true)
      expect(view.state.doc.toString()).toBe('see [[P]]')
      expect(repo.tx).not.toHaveBeenCalled()
    } finally {
      view.destroy()
    }
  })

  it('writes nothing when the mounted editor no longer holds the target', async () => {
    // The stored row trails the editor by its debounce and may still hold
    // the target; the editor is the authority while it's mounted.
    const view = mounted('see nothing')
    try {
      const {repo, replaced} = run(view)
      expect(await replaced).toBe(false)
      expect(repo.tx).not.toHaveBeenCalled()
    } finally {
      view.destroy()
    }
  })

  it('falls back to the stored row once the editor has unmounted', async () => {
    const view = mounted('see LINK')
    view.destroy()
    view.dom.remove()
    const {repo, replaced} = run(view)
    await replaced
    expect(repo.tx).toHaveBeenCalledTimes(1)
  })
})
