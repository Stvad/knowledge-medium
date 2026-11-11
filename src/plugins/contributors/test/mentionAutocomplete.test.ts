// @vitest-environment happy-dom
import { CompletionContext } from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import { PAGE_TYPE } from '@/data/blockTypes'
import { aliasesProp, typesProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { contributorsDataExtension } from '../dataExtension'
import { createContributor } from '../profiles'
import { CONTRIBUTOR_TYPE, contributorKindProp, type ContributorKind } from '../schema'
import {
  contributorMentionCandidates,
  contributorMentionSource,
  loadContributorMentionCandidates,
  type ContributorMentionCandidate,
} from '../mentionAutocomplete'

const profile = (id: string, content: string, kind: ContributorKind = 'agent'): BlockData => ({
  id,
  content,
  properties: {
    [typesProp.name]: ['page', CONTRIBUTOR_TYPE],
    [contributorKindProp.name]: kind,
  },
}) as unknown as BlockData

describe('contributorMentionCandidates', () => {
  const profiles = [
    profile('a', 'Clio'),
    profile('b', 'Cobalt Reviewer'),
    profile('c', 'Nightly import', 'automation'),
    profile('d', 'Ada', 'human'),
  ]
  const ownId = async (alias: string) => profiles.find(p => p.content === alias)?.id ?? null
  const names = async (query: string) =>
    (await contributorMentionCandidates(profiles, query, ownId)).map(c => c.name)

  it('offers humans and agents by word prefix, not automations, and not fuzzily', async () => {
    expect(await names('rev')).toEqual(['Cobalt Reviewer'])
    expect(await names('CLI')).toEqual(['Clio'])
    expect(await names('a')).toEqual(['Ada'])
    expect(await names('nigh')).toEqual([])
    // `cbl` is an in-order subsequence of "Cobalt" — a fuzzy match would take it.
    expect(await names('cbl')).toEqual([])
  })

  it('drops a title the wikilink grammar cannot carry faithfully', async () => {
    // `[[Agent]]]` parses as a link to `Agent` plus a stray bracket.
    expect(await contributorMentionCandidates([profile('g', 'Agent]')], 'ag', async () => 'g')).toEqual([])
  })

  it('carries the verified wikilink text for the pick to insert', async () => {
    const [candidate] = await contributorMentionCandidates([profile('a', ' Clio ')], 'c', async () => 'a')
    expect(candidate).toEqual({id: 'a', name: 'Clio', kind: 'agent', wikilink: '[[Clio]]'})
  })
})

describe('loadContributorMentionCandidates', () => {
  const WS = 'workspace'
  let db: TestDb
  let repo: Repo

  beforeAll(async () => { db = await createTestDb() })
  afterAll(async () => { await db.cleanup() })
  const freshRepo = () =>
    createTestRepo({db: db.db, user: {id: 'u', name: 'Owner'}, extensions: [contributorsDataExtension]}).repo
  beforeEach(async () => {
    await resetTestDb(db.db)
    repo = freshRepo()
  })

  it('drops a contributor whose title an older page co-claims, since [[title]] links that page', async () => {
    await createContributor(repo, WS, {name: 'Clio', kind: 'agent'})
    expect((await loadContributorMentionCandidates(repo, WS, 'cl')).map(c => c.name)).toEqual(['Clio'])

    // A sync-applied claimant can co-own an alias; a raw write bypasses the
    // local uniqueness trigger the way sync apply does. It also fires no
    // query invalidation, so the read after it uses a fresh repo.
    await db.db.writeTransaction(async raw => {
      await raw.execute(`INSERT INTO blocks
        (id, workspace_id, parent_id, order_key, content, properties_json, references_json,
         created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
        VALUES (?, ?, NULL, ?, ?, ?, '[]', 1, 1, 1, 'sync-user', 'sync-user', 0)`, [
        'older-page', WS, 'k-older-page', 'Clio',
        JSON.stringify({[typesProp.name]: [PAGE_TYPE], [aliasesProp.name]: ['Clio']}),
      ])
    })
    expect(await loadContributorMentionCandidates(freshRepo(), WS, 'cl')).toEqual([])
  })
})

describe('contributorMentionSource', () => {
  const clio: ContributorMentionCandidate = {id: 'a', name: 'Clio', kind: 'agent', wikilink: '[[Clio]]'}
  const source = contributorMentionSource(async () => [clio])

  it('replaces the whole @query with the wikilink', async () => {
    const doc = 'ask @cla'
    const view = new EditorView({state: EditorState.create({doc, selection: {anchor: doc.length}})})
    const result = await source(new CompletionContext(view.state, doc.length, false))
    expect(result).toMatchObject({from: 4, to: 8, filter: false})
    const option = result!.options[0]
    ;(option.apply as (v: EditorView, c: unknown, from: number, to: number) => void)(view, option, 4, 8)
    expect(view.state.doc.toString()).toBe('ask [[Clio]]')
    view.destroy()
  })

  it('a bare @ starts the span after the @, so the filter keeps every row, and the pick still replaces the @', async () => {
    const doc = 'ask @'
    const view = new EditorView({state: EditorState.create({doc, selection: {anchor: doc.length}})})
    const result = await source(new CompletionContext(view.state, doc.length, false))
    expect(result).toMatchObject({from: 5, to: 5})
    expect(result!.filter).not.toBe(false)
    const option = result!.options[0]
    ;(option.apply as (v: EditorView, c: unknown, from: number, to: number) => void)(view, option, 5, 5)
    expect(view.state.doc.toString()).toBe('ask [[Clio]]')
    expect(view.state.selection.main.head).toBe(12)
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
