// @vitest-environment happy-dom
import { CompletionContext } from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import { aliasesProp, typesProp } from '@/data/properties'
import { CONTRIBUTOR_TYPE, contributorKindProp, type ContributorKind } from '../schema'
import {
  contributorMentionCandidates,
  contributorMentionSource,
  matchContributorTrigger,
  type ContributorMentionCandidate,
} from '../mentionAutocomplete'

const profile = (
  id: string,
  content: string,
  {kind = 'agent', aliases = [content], deleted = false}: {kind?: ContributorKind, aliases?: string[], deleted?: boolean} = {},
): BlockData => ({
  id,
  content,
  deleted,
  properties: {
    [aliasesProp.name]: aliases,
    [typesProp.name]: ['page', CONTRIBUTOR_TYPE],
    [contributorKindProp.name]: kind,
  },
}) as unknown as BlockData

describe('matchContributorTrigger', () => {
  it('fires on a single @ and leaves @@ to places', () => {
    expect(matchContributorTrigger('ask @cla', 8)).toEqual({from: 4, query: 'cla'})
    expect(matchContributorTrigger('ask @@cla', 9)).toBeNull()
  })
})

describe('contributorMentionCandidates', () => {
  const profiles = [
    profile('a', 'Clio'),
    profile('b', 'Cobalt Reviewer'),
    profile('c', 'Nightly import', {kind: 'automation'}),
    profile('d', 'Ada', {kind: 'human'}),
    profile('e', 'Shadowed', {aliases: []}),
    profile('f', 'Gone', {deleted: true}),
  ]

  it('lists addressable profiles that own their title, on an empty query', () => {
    expect(contributorMentionCandidates(profiles, '').map(c => c.name))
      .toEqual(['Clio', 'Cobalt Reviewer', 'Ada'])
  })

  it('matches by word prefix, not fuzzily', () => {
    expect(contributorMentionCandidates(profiles, 'rev').map(c => c.name)).toEqual(['Cobalt Reviewer'])
    expect(contributorMentionCandidates(profiles, 'CLI').map(c => c.name)).toEqual(['Clio'])
    // `cbl` is an in-order subsequence of "Cobalt" — a fuzzy match would take it.
    expect(contributorMentionCandidates(profiles, 'cbl')).toEqual([])
  })

  it('inserts the alias as the profile owns it', () => {
    const [candidate] = contributorMentionCandidates([profile('a', 'clio ', {aliases: ['Clio']})], '')
    expect(candidate).toMatchObject({id: 'a', name: 'Clio', kind: 'agent'})
  })
})

describe('contributorMentionSource', () => {
  const clio: ContributorMentionCandidate = {id: 'a', name: 'Clio', kind: 'agent'}
  const source = contributorMentionSource(async () => [clio])

  const viewAt = (doc: string, extensions = [] as never[]) => new EditorView({
    state: EditorState.create({doc, selection: {anchor: doc.length}, extensions}),
  })

  it('replaces the whole @query with a wikilink', async () => {
    const view = viewAt('ask @cla')
    const result = await source(new CompletionContext(view.state, view.state.doc.length, false))
    expect(result).toMatchObject({from: 4, to: 8, filter: false})
    const option = result!.options[0]
    expect(option.section).toMatchObject({name: 'Contributors'})
    ;(option.apply as (v: EditorView, c: unknown, from: number, to: number) => void)(view, option, 4, 8)
    expect(view.state.doc.toString()).toBe('ask [[Clio]]')
    view.destroy()
  })

  it('stays silent inside inline code, but fires in prose', async () => {
    const at = (doc: string, pos: number) => source(new CompletionContext(
      EditorState.create({doc, extensions: [markdown({base: markdownLanguage})]}), pos, false,
    ))
    const inline = 'use `@cla` here'
    expect(await at(inline, inline.indexOf('`', 5))).toBeNull()
    expect(await at('ask @cla', 8)).not.toBeNull()
  })
})
