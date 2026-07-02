// @vitest-environment jsdom
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import type { TypeContribution } from '@/data/api'
import { PAGE_TYPE } from '@/data/blockTypes'
import {
  buildTypeTagCandidates,
  matchHashTrigger,
  typeTagCompletionSource,
  type TypeTagCandidate,
} from '../typeAutocomplete'

describe('matchHashTrigger', () => {
  it('matches # at start of line', () => {
    expect(matchHashTrigger('#task', 5)).toEqual({from: 0, query: 'task'})
  })

  it('matches # after whitespace', () => {
    expect(matchHashTrigger('call mom #todo', 14)).toEqual({from: 9, query: 'todo'})
  })

  it('matches # with an empty query (right after the #)', () => {
    expect(matchHashTrigger('call mom #', 10)).toEqual({from: 9, query: ''})
  })

  it('matches after non-word punctuation', () => {
    expect(matchHashTrigger('(#task', 6)).toEqual({from: 1, query: 'task'})
  })

  it('matches multi-word queries across single spaces', () => {
    expect(matchHashTrigger('#meeting note', 13)).toEqual({from: 0, query: 'meeting note'})
  })

  it('does NOT match a markdown heading (query starts with a space)', () => {
    expect(matchHashTrigger('# Title', 7)).toBeNull()
  })

  it('does NOT match stacked hashes (## heading territory)', () => {
    expect(matchHashTrigger('##task', 6)).toBeNull()
  })

  it('does NOT match with a word char before the # (URL anchors, a#b)', () => {
    expect(matchHashTrigger('example.com/page#section', 24)).toBeNull()
    expect(matchHashTrigger('a#b', 3)).toBeNull()
  })

  it('does NOT match inside [[wikilink]] brackets', () => {
    expect(matchHashTrigger('[[#foo', 6)).toBeNull()
    expect(matchHashTrigger('[[foo #bar', 10)).toBeNull()
  })

  it('does NOT match when there is no # in the current token', () => {
    expect(matchHashTrigger('plain prose', 11)).toBeNull()
  })

  it('does NOT match across a double space (query over, prose resumed)', () => {
    expect(matchHashTrigger('#home  later that day', 21)).toBeNull()
  })

  it('does NOT match across tabs', () => {
    expect(matchHashTrigger('#foo\tbar', 8)).toBeNull()
  })

  it('does NOT match once the query exceeds the word cap', () => {
    expect(matchHashTrigger('#one two three four five six', 28))
      .toEqual({from: 0, query: 'one two three four five six'})
    expect(matchHashTrigger('#one two three four five six seven', 34)).toBeNull()
  })

  it('does NOT match once the query exceeds the length cap', () => {
    const long = `#${'a'.repeat(60)}`
    expect(matchHashTrigger(long, long.length)).toBeNull()
  })
})

const registryOf = (...types: TypeContribution[]): ReadonlyMap<string, TypeContribution> =>
  new Map(types.map(t => [t.id, t]))

const TASK: TypeContribution = {id: 'uuid-task', label: 'Task'}
const TRIP: TypeContribution = {id: 'uuid-trip', label: 'Trip', description: 'A journey'}
const TODO: TypeContribution = {id: 'todo', label: 'Todo'}
const PAGE: TypeContribution = {id: PAGE_TYPE, label: 'Page'}

describe('buildTypeTagCandidates', () => {
  it('lists all visible types for an empty query, without a create sentinel', () => {
    const out = buildTypeTagCandidates({
      registry: registryOf(TASK, TRIP, PAGE),
      currentTypeIds: [],
      query: '',
    })
    expect(out.map(c => c.id)).toEqual(['uuid-task', 'uuid-trip'])
    expect(out.every(c => c.kind === 'existing')).toBe(true)
  })

  it('filters by label and id, case-insensitively', () => {
    const byLabel = buildTypeTagCandidates({
      registry: registryOf(TASK, TRIP),
      currentTypeIds: [],
      query: 'tA',
    })
    expect(byLabel.filter(c => c.kind === 'existing').map(c => c.id)).toEqual(['uuid-task'])

    const byId = buildTypeTagCandidates({
      registry: registryOf(TODO, TRIP),
      currentTypeIds: [],
      query: 'todo',
    })
    expect(byId[0]).toMatchObject({kind: 'existing', id: 'todo'})
  })

  it('excludes types already on the block', () => {
    const out = buildTypeTagCandidates({
      registry: registryOf(TASK, TRIP),
      currentTypeIds: ['uuid-task'],
      query: '',
    })
    expect(out.map(c => c.id)).toEqual(['uuid-trip'])
  })

  it('excludes structural kernel types like page', () => {
    const out = buildTypeTagCandidates({
      registry: registryOf(PAGE, TASK),
      currentTypeIds: [],
      query: 'pa',
    })
    expect(out.filter(c => c.kind === 'existing')).toEqual([])
  })

  it('ranks prefix matches above contains matches', () => {
    const stash: TypeContribution = {id: 'uuid-stash', label: 'Stash'}
    const shopping: TypeContribution = {id: 'uuid-shop', label: 'Shopping'}
    const out = buildTypeTagCandidates({
      registry: registryOf(stash, shopping),
      currentTypeIds: [],
      query: 'sh',
    })
    expect(out.filter(c => c.kind === 'existing').map(c => c.label))
      .toEqual(['Shopping', 'Stash'])
  })

  it('appends a create sentinel for a non-matching query, trimmed', () => {
    const out = buildTypeTagCandidates({
      registry: registryOf(TASK),
      currentTypeIds: [],
      query: 'Recipe ',
    })
    expect(out[out.length - 1]).toMatchObject({kind: 'create', label: 'Recipe'})
  })

  it('offers no create sentinel when the query exactly matches a label — even a hidden or already-applied one', () => {
    const hidden = buildTypeTagCandidates({
      registry: registryOf(PAGE),
      currentTypeIds: [],
      query: 'page',
    })
    expect(hidden).toEqual([])

    const applied = buildTypeTagCandidates({
      registry: registryOf(TASK),
      currentTypeIds: ['uuid-task'],
      query: 'task',
    })
    expect(applied).toEqual([])
  })

  it('carries the type description as detail', () => {
    const out = buildTypeTagCandidates({
      registry: registryOf(TRIP),
      currentTypeIds: [],
      query: 'trip',
    })
    expect(out[0].detail).toBe('A journey')
  })
})

describe('typeTagCompletionSource', () => {
  const contextFor = (doc: string, pos: number, explicit = false): CompletionContext =>
    new CompletionContext(EditorState.create({doc}), pos, explicit)

  const candidate = (over: Partial<TypeTagCandidate> = {}): TypeTagCandidate => ({
    kind: 'existing',
    id: 'uuid-task',
    label: 'Task',
    ...over,
  })

  it('returns null when there is no # trigger at the cursor', async () => {
    const source = typeTagCompletionSource({
      getCandidates: () => [candidate()],
      pickType: async () => {},
    })
    expect(await source(contextFor('plain prose', 11))).toBeNull()
  })

  it('anchors the result at the # and labels the create sentinel', async () => {
    const source = typeTagCompletionSource({
      getCandidates: () => [candidate(), candidate({kind: 'create', id: 'create:Recipe', label: 'Recipe'})],
      pickType: async () => {},
    })
    const result = await source(contextFor('note #rec', 9))
    expect(result).toMatchObject({from: 5, to: 9, filter: false})
    expect(result!.options.map(o => o.label)).toEqual(['Task', 'Create type "Recipe"'])
  })

  it('returns null for zero candidates unless explicitly invoked', async () => {
    const source = typeTagCompletionSource({
      getCandidates: () => [],
      pickType: async () => {},
    })
    expect(await source(contextFor('#zzz', 4))).toBeNull()
    const explicit = await source(contextFor('#zzz', 4, true))
    expect(explicit).toMatchObject({options: []})
  })

  it('on apply, deletes the trigger text and hands the candidate to pickType', async () => {
    const picked: TypeTagCandidate[] = []
    const source = typeTagCompletionSource({
      getCandidates: () => [candidate()],
      pickType: async c => { picked.push(c) },
    })
    const view = new EditorView({
      state: EditorState.create({doc: 'call mom #ta'}),
      parent: document.body,
    })
    try {
      const result = await source(new CompletionContext(view.state, 12, false))
      const option = result!.options[0]
      const apply = option.apply as (view: EditorView, c: unknown, from: number, to: number) => void
      apply(view, option, result!.from, 12)
      expect(view.state.doc.toString()).toBe('call mom ')
      expect(view.state.selection.main.head).toBe(9)
      expect(picked).toEqual([candidate()])
    } finally {
      view.destroy()
    }
  })

  it('surfaces a failed pick as a console warning, not an unhandled rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const source = typeTagCompletionSource({
        getCandidates: () => [candidate()],
        pickType: async () => { throw new Error('registry says no') },
      })
      const view = new EditorView({
        state: EditorState.create({doc: '#ta'}),
        parent: document.body,
      })
      try {
        const result = await source(new CompletionContext(view.state, 3, false))
        const option = result!.options[0]
        const apply = option.apply as (view: EditorView, c: unknown, from: number, to: number) => void
        apply(view, option, result!.from, 3)
        await vi.waitFor(() => {
          expect(warn).toHaveBeenCalledWith(
            '[supertags] failed to apply type', 'uuid-task', expect.any(Error))
        })
      } finally {
        view.destroy()
      }
    } finally {
      warn.mockRestore()
    }
  })
})
