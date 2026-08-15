import { describe, it, expect, vi } from 'vitest'
import { EditorState, EditorSelection } from '@codemirror/state'
import { CompletionContext, insertBracket } from '@codemirror/autocomplete'
import { blockrefCompletionSource } from '../blockrefAutocomplete'

const makeContext = (text: string, pos: number, explicit = false) => {
  const state = EditorState.create({doc: text})
  return new CompletionContext(state, pos, explicit)
}

describe('blockrefCompletionSource', () => {
  it('returns null when cursor is not inside ((', async () => {
    const searchBlocks = vi.fn().mockResolvedValue([])
    const source = blockrefCompletionSource({searchBlocks})
    const result = await source(makeContext('plain text', 5))
    expect(result).toBeNull()
    expect(searchBlocks).not.toHaveBeenCalled()
  })

  it('searches with the typed filter when cursor is inside ((', async () => {
    const searchBlocks = vi.fn().mockResolvedValue([
      {id: 'block-1', content: 'first hit'},
      {id: 'block-2', content: 'second hit'},
    ])
    const source = blockrefCompletionSource({searchBlocks})

    // "((foo" — cursor at position 5
    const result = await source(makeContext('((foo', 5))
    expect(searchBlocks).toHaveBeenCalledWith('foo')
    expect(result).toMatchObject({from: 2, to: 5})
    expect(result?.options.map(o => o.label)).toEqual(['first hit', 'second hit'])
  })

  it('skips empty-filter searches unless explicitly invoked', async () => {
    const searchBlocks = vi.fn()
    const source = blockrefCompletionSource({searchBlocks})
    const result = await source(makeContext('((', 2))
    expect(result).toBeNull()
    expect(searchBlocks).not.toHaveBeenCalled()
  })

  it('searches on empty filter when context.explicit is true', async () => {
    const searchBlocks = vi.fn().mockResolvedValue([{id: 'b1', content: 'hi'}])
    const source = blockrefCompletionSource({searchBlocks})
    const result = await source(makeContext('((', 2, true))
    expect(searchBlocks).toHaveBeenCalledWith('')
    expect(result?.options).toHaveLength(1)
  })

  it('falls back to id when content is empty', async () => {
    const searchBlocks = vi.fn().mockResolvedValue([{id: 'block-only', content: ''}])
    const source = blockrefCompletionSource({searchBlocks})
    const result = await source(makeContext('((x', 3))
    expect(result?.options[0].label).toBe('block-only')
  })

  // Same shape as the `[[` case: `closeBrackets` wrapping a selection leaves
  // the text selected, and CodeMirror anchors the context at the range's
  // `from` — just after the `((`. Read there, the filter is empty and the
  // source bails, so wrapping a selection in `((` offered nothing at all.
  it('searches on text wrapped by typing (( over a selection', async () => {
    let state = EditorState.create({doc: 'hello world', selection: EditorSelection.range(6, 11)})
    for (const bracket of '((') state = insertBracket(state, bracket)!.state
    expect(state.doc.toString()).toBe('hello ((world))')

    const searchBlocks = vi.fn().mockResolvedValue([{id: 'b1', content: 'a world block'}])
    const source = blockrefCompletionSource({searchBlocks})
    const result = await source(new CompletionContext(state, state.selection.main.from, false))
    expect(searchBlocks).toHaveBeenCalledWith('world')
    expect(result).toMatchObject({from: 8, to: 13})
  })

  it('does not span across an earlier closed (())', async () => {
    const searchBlocks = vi.fn().mockResolvedValue([])
    const source = blockrefCompletionSource({searchBlocks})
    // The earlier `((id))` should not be picked up; from cursor=12 there is
    // no open `((` to anchor on, so we get null.
    const result = await source(makeContext('((abc)) more', 12))
    expect(result).toBeNull()
  })
})
