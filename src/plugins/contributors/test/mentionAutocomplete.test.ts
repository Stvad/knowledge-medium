// @vitest-environment happy-dom
import { CompletionContext } from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import { typesProp } from '@/data/properties'
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
  {kind = 'agent', deleted = false}: {kind?: ContributorKind, deleted?: boolean} = {},
): BlockData => ({
  id,
  content,
  deleted,
  properties: {
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
    profile('e', 'Shadowed'),
    profile('f', 'Gone', {deleted: true}),
  ]
  // What `[[alias]]` binds to: every title resolves to its own profile,
  // except `Shadowed`, which an older page also claims (a sync co-claim).
  const resolveAlias = async (alias: string) =>
    alias === 'Shadowed' ? 'older-page' : profiles.find(p => p.content === alias)?.id ?? null
  const names = async (query: string, list = profiles) =>
    (await contributorMentionCandidates(list, query, resolveAlias)).map(c => c.name)

  it('lists addressable profiles whose link resolves to them, on an empty query', async () => {
    expect(await names('')).toEqual(['Clio', 'Cobalt Reviewer', 'Ada'])
  })

  it('matches by word prefix, not fuzzily', async () => {
    expect(await names('rev')).toEqual(['Cobalt Reviewer'])
    expect(await names('CLI')).toEqual(['Clio'])
    // `cbl` is an in-order subsequence of "Cobalt" — a fuzzy match would take it.
    expect(await names('cbl')).toEqual([])
  })

  it('drops a title the wikilink grammar cannot carry faithfully', async () => {
    // `[[Agent]]]` parses as a link to `Agent` plus a stray bracket.
    const agent = profile('g', 'Agent]')
    expect(await contributorMentionCandidates([agent], '', async () => 'g')).toEqual([])
  })

  it('carries the verified wikilink text for the pick to insert', async () => {
    const [candidate] = await contributorMentionCandidates([profile('a', ' Clio ')], '', async () => 'a')
    expect(candidate).toEqual({id: 'a', name: 'Clio', kind: 'agent', wikilink: '[[Clio]]'})
  })
})

describe('contributorMentionSource', () => {
  const clio: ContributorMentionCandidate = {id: 'a', name: 'Clio', kind: 'agent', wikilink: '[[Clio]]'}
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
