// @vitest-environment jsdom
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import type { TypeContribution } from '@/data/api'
import { PAGE_TYPE } from '@/data/blockTypes'
import {
  buildTypeTagCandidates,
  findTaggableTypeByName,
  matchHashTrigger,
  restoreTriggerToView,
  typeTagCompletionSource,
  visibleTagTypeIds,
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

const existingIds = (out: readonly TypeTagCandidate[]): string[] =>
  out.flatMap(c => c.kind === 'existing' ? [c.id] : [])

const TASK: TypeContribution = {id: 'uuid-task', label: 'Task'}
const TRIP: TypeContribution = {id: 'uuid-trip', label: 'Trip', description: 'A journey'}
const TODO: TypeContribution = {id: 'todo', label: 'Todo'}
const PAGE: TypeContribution = {id: PAGE_TYPE, label: 'Page', structural: true}
const PREFS: TypeContribution = {id: 'quick-find-ui-state', label: 'Quick find', structural: true}

describe('buildTypeTagCandidates', () => {
  it('lists all visible types for an empty query, without a create sentinel', () => {
    const out = buildTypeTagCandidates({
      registry: registryOf(TASK, TRIP, PAGE),
      currentTypeIds: [],
      query: '',
    })
    expect(existingIds(out)).toEqual(['uuid-task', 'uuid-trip'])
    expect(out.every(c => c.kind === 'existing')).toBe(true)
  })

  it('filters by label and id, case-insensitively', () => {
    const byLabel = buildTypeTagCandidates({
      registry: registryOf(TASK, TRIP),
      currentTypeIds: [],
      query: 'tA',
    })
    expect(existingIds(byLabel)).toEqual(['uuid-task'])

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
    expect(existingIds(out)).toEqual(['uuid-trip'])
  })

  it('excludes structural contributions — kernel structure and plugin plumbing alike', () => {
    const out = buildTypeTagCandidates({
      registry: registryOf(PAGE, PREFS, TASK),
      currentTypeIds: [],
      query: '',
    })
    expect(existingIds(out)).toEqual(['uuid-task'])
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

  it('offers no create sentinel when the query exactly matches a taggable label — even an already-applied one', () => {
    const applied = buildTypeTagCandidates({
      registry: registryOf(TASK),
      currentTypeIds: ['uuid-task'],
      query: 'task',
    })
    expect(applied).toEqual([])
  })

  it('an exact match on a STRUCTURAL label is not a dead end — create is offered', () => {
    // Without this, `#page` / `#user` would silently show nothing:
    // the structural type never appears as a candidate, and its label
    // suppressing the sentinel would leave zero options.
    const out = buildTypeTagCandidates({
      registry: registryOf(PAGE),
      currentTypeIds: [],
      query: 'page',
    })
    expect(out).toEqual([{kind: 'create', label: 'page', detail: 'Create new type'}])
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

describe('visibleTagTypeIds', () => {
  const HIDDEN: TypeContribution = {id: 'uuid-secret', label: 'Secret', hideTag: true}

  it('drops structural kernel types and hideTag opt-outs, keeps the rest in order', () => {
    const registry = registryOf(TASK, TRIP, PAGE, HIDDEN)
    expect(visibleTagTypeIds(
      ['uuid-task', PAGE_TYPE, 'uuid-secret', 'uuid-trip'], registry))
      .toEqual(['uuid-task', 'uuid-trip'])
  })

  it('keeps types missing from the registry (label falls back to the id)', () => {
    expect(visibleTagTypeIds(['uuid-unknown'], registryOf())).toEqual(['uuid-unknown'])
  })

  it('hideTag types stay offerable in the # autocomplete', () => {
    const out = buildTypeTagCandidates({
      registry: registryOf(HIDDEN),
      currentTypeIds: [],
      query: 'sec',
    })
    expect(out[0]).toMatchObject({kind: 'existing', id: 'uuid-secret'})
  })
})

describe('typeTagCompletionSource', () => {
  const contextFor = (doc: string, pos: number, explicit = false): CompletionContext =>
    new CompletionContext(EditorState.create({doc}), pos, explicit)

  const candidate = (): TypeTagCandidate => ({kind: 'existing', id: 'uuid-task', label: 'Task'})

  it('returns null when there is no # trigger at the cursor', async () => {
    const source = typeTagCompletionSource({
      getCandidates: () => [candidate()],
      pickType: async () => {},
    })
    expect(await source(contextFor('plain prose', 11))).toBeNull()
  })

  it('anchors the result at the # and labels the create sentinel', async () => {
    const source = typeTagCompletionSource({
      getCandidates: () => [candidate(), {kind: 'create', label: 'Recipe'}],
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

  it('a failed pick restores the deleted trigger text into the view and warns', async () => {
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
        expect(view.state.doc.toString()).toBe('')
        await vi.waitFor(() => {
          expect(warn).toHaveBeenCalledWith(
            '[supertags] failed to apply type', 'Task', expect.any(Error))
          expect(view.state.doc.toString()).toBe('#ta')
        })
        expect(view.state.selection.main.head).toBe(3)
      } finally {
        view.destroy()
      }
    } finally {
      warn.mockRestore()
    }
  })

  it('falls back to restoreTrigger when the view is unmounted at failure time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const restored: string[] = []
      let failPick: () => void = () => {}
      const source = typeTagCompletionSource({
        getCandidates: () => [candidate()],
        pickType: () => new Promise((_, reject) => {
          failPick = () => reject(new Error('too late'))
        }),
        restoreTrigger: async ({triggerText}) => { restored.push(triggerText) },
      })
      const view = new EditorView({
        state: EditorState.create({doc: '#ta'}),
        parent: document.body,
      })
      const result = await source(new CompletionContext(view.state, 3, false))
      const option = result!.options[0]
      const apply = option.apply as (view: EditorView, c: unknown, from: number, to: number) => void
      apply(view, option, result!.from, 3)
      view.destroy()
      failPick()
      await vi.waitFor(() => {
        expect(restored).toEqual(['#ta'])
      })
    } finally {
      warn.mockRestore()
    }
  })
})

describe('findTaggableTypeByName', () => {
  it('matches label and id case-insensitively, skipping structural types', () => {
    const registry = registryOf(TASK, PAGE)
    expect(findTaggableTypeByName(registry, 'tAsK')).toBe(TASK)
    expect(findTaggableTypeByName(registry, 'uuid-task')).toBe(TASK)
    expect(findTaggableTypeByName(registry, 'Page')).toBeUndefined()
    expect(findTaggableTypeByName(registry, '')).toBeUndefined()
  })
})

describe('restoreTriggerToView', () => {
  it('re-inserts at the original spot, clamped to the live doc', () => {
    const view = new EditorView({
      state: EditorState.create({doc: 'ab'}),
      parent: document.body,
    })
    try {
      expect(restoreTriggerToView(view, 9, '#ta')).toBe(true)
      expect(view.state.doc.toString()).toBe('ab#ta')
    } finally {
      view.destroy()
    }
  })

  it('returns false for an unmounted view', () => {
    const view = new EditorView({state: EditorState.create({doc: 'ab'})})
    view.destroy()
    expect(restoreTriggerToView(view, 0, '#ta')).toBe(false)
  })
})
