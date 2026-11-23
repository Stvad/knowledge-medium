// @vitest-environment happy-dom
import {CompletionContext, type Completion, type CompletionResult} from '@codemirror/autocomplete'
import {EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {describe, expect, it} from 'vitest'
import {referenceTargetTypes} from '@/editor/referenceTargetTypes'
import {backlinkCompletionSource} from '@/utils/backlinkAutocomplete'
import {blockrefCompletionSource} from '@/utils/blockrefAutocomplete'

const accept = (view: EditorView, result: CompletionResult) => {
  const completion = result.options[0] as Completion
  if (typeof completion.apply !== 'function') throw new Error('expected apply function')
  completion.apply(view, completion, result.from, result.to ?? view.state.selection.main.from)
}

describe('reference completion token replacement', () => {
  it.each([
    {text: '[[foo trailing prose', pos: 5, expected: '[[Alice]] trailing prose', kind: 'alias'},
    {text: '((foo trailing prose', pos: 5, expected: '((target)) trailing prose', kind: 'block'},
    {text: '[[foo trailing]]', pos: 5, expected: '[[Alice trailing]]', kind: 'alias'},
    {text: '((foo trailing))', pos: 5, expected: '((target)) trailing))', kind: 'block'},
  ])('preserves ordinary suffix: $text', async ({text, pos, expected, kind}) => {
    const state = EditorState.create({doc: text})
    const view = new EditorView({state})
    try {
      const source = kind === 'alias'
        ? backlinkCompletionSource({getAliases: async () => ['Alice']})
        : blockrefCompletionSource({searchBlocks: async () => [{id: 'target', content: 'Alice'}]})
      const result = await source(new CompletionContext(state, pos, true))
      expect(result).not.toBeNull()
      accept(view, result!)
      expect(view.state.doc.toString()).toBe(expected)
    } finally { view.destroy() }
  })

  it.each([
    {text: '[[Alice]]', pos: 4, expected: '[[Bob]]', kind: 'alias'},
    {text: '((Alice))', pos: 4, expected: '((target))', kind: 'block'},
  ])('replaces the rest of a whole constrained token: $text', async ({text, pos, expected, kind}) => {
    const state = EditorState.create({doc: text, extensions: [referenceTargetTypes.of(['person'])]})
    const view = new EditorView({state})
    try {
      const source = kind === 'alias'
        ? backlinkCompletionSource({getAliases: async () => ['Bob']})
        : blockrefCompletionSource({searchBlocks: async () => [{id: 'target', content: 'Bob'}]})
      const result = await source(new CompletionContext(state, pos, true))
      expect(result).not.toBeNull()
      accept(view, result!)
      expect(view.state.doc.toString()).toBe(expected)
    } finally { view.destroy() }
  })

  it('does not consume a nested opener as part of a whole token', async () => {
    const state = EditorState.create({doc: '((foo((bar))', extensions: [referenceTargetTypes.of(['person'])]})
    const view = new EditorView({state})
    try {
      const result = await blockrefCompletionSource({searchBlocks: async () => [{id: 'target', content: 'Bob'}]})(new CompletionContext(state, 5, true))
      expect(result).not.toBeNull()
      accept(view, result!)
      expect(view.state.doc.toString()).toBe('((target))((bar))')
    } finally { view.destroy() }
  })
})
