// @vitest-environment happy-dom
/** Completion in a table's query, run as the editor runs it: every source the
 *  block's editor gets (the `#` type tag and the query's), asked at the cursor. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompletionContext, type Completion, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { ChangeScope, codecs, defineProperty, seedType, type AnyPropertySchema } from '@/data/api'
import { materializePropertySeeds, propertyDefinitionBlockId } from '@/data/definitionSeeds'
import { projectedPropertyDefinitionsFacet, typeSeedsFacet } from '@/data/facets'
import { getBlockTypes } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { supertagsCodeMirrorExtensions } from '@/plugins/supertags/codeMirrorExtensions'
import { tablesDataExtension } from '../dataExtension'
import { queryCompletionExtension, queryTriggerAt } from '../query/completion'
import { parseQuery } from '../query/parse'
import { openQueryValue } from '../query/queryValue'
import { fencedQuery, queryResolver, queryTextOf } from '../query/source'
import { queryProp } from '../schema'

const workspaceId = 'ws-query-completion'
const options = {scope: ChangeScope.BlockDefault}

const user = (name: string, codec: AnyPropertySchema['codec']) =>
  defineProperty(name, {codec, defaultValue: undefined, changeScope: ChangeScope.BlockDefault}) as AnyPropertySchema
const PROPERTIES = [user('status', codecs.string), user('stash', codecs.unsafeIdentity<unknown>()), user('created', codecs.string)]
const fieldIdOf = (name: string) => `def-${name}`

let db: TestDb
let repo: Repo
let valueId: string
let queryValueSchema: AnyPropertySchema
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(async () => { await repo.awaitProcessors() })
beforeEach(async () => {
  await resetTestDb(db.db)
  await db.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
      VALUES (?, 'test', 'test-user', 1, 1, 'none', 'children')`, [workspaceId])
  ;({repo} = createTestRepo({db: db.db, extensions: [
    tablesDataExtension,
    typeSeedsFacet.of(seedType({seedKey: 'test/type/book', revision: 1, id: 'book', label: 'Book'}), {source: 'test'}),
    typeSeedsFacet.of(seedType({seedKey: 'test/type/other-book', revision: 1, id: 'other:book', label: 'Book'}), {source: 'test'}),
  ]}))
  repo.setActiveWorkspaceId(workspaceId)
  repo.setRuntimeContributions(projectedPropertyDefinitionsFacet, 'test-definitions', PROPERTIES.map(schema => ({
    metadata: {fieldId: fieldIdOf(schema.name), workspaceId, createdAt: 1, name: schema.name,
      changeScope: schema.changeScope, hidden: false, origin: 'user' as const},
    schema,
  })), {workspaceId})
  await repo.whenPropertyDefinitionsReady(workspaceId)
  await repo.tx(async tx => {
    for (const schema of PROPERTIES) {
      await tx.create({id: fieldIdOf(schema.name), workspaceId, parentId: null, orderKey: `d-${schema.name}`,
        content: schema.name, properties: {types: ['property-schema']}})
    }
    await tx.create({id: 'host', workspaceId, parentId: null, orderKey: 'h', content: 'Reading'})
    await tx.create({id: 'note', workspaceId, parentId: null, orderKey: 'n', content: ''})
  }, options)
  await materializePropertySeeds(repo, workspaceId, [queryProp])
  const queryFieldId = propertyDefinitionBlockId(workspaceId, queryProp.seedKey)
  valueId = await openQueryValue(repo, 'host', queryFieldId)
  const resolved = repo.propertySchemaResolverFor(workspaceId).resolveField(queryFieldId)
  if (resolved.status !== 'resolved') throw new Error('query property did not resolve')
  queryValueSchema = resolved.schema
})

const views: EditorView[] = []
afterEach(() => { views.splice(0).forEach(view => view.destroy()) })

/** An editor on `blockId` holding `doc`, the cursor at `|`, with the extensions
 *  the renderer gives it: `asQueryValue` when it is drawn as the query's value. */
const editor = async (blockId: string, docWithCursor: string, asQueryValue: boolean) => {
  const block = repo.block(blockId)
  await block.load()
  const context = {repo, block, propertyValueSchema: asQueryValue ? queryValueSchema : undefined}
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: docWithCursor.replace('|', ''),
      selection: {anchor: docWithCursor.indexOf('|')},
      extensions: [markdown({base: markdownLanguage}), supertagsCodeMirrorExtensions(context), queryCompletionExtension(context)],
    }),
  })
  views.push(view)
  return view
}

/** What each of the editor's completion sources answers at the cursor, as the autocompletion asks them. */
const answers = async (view: EditorView): Promise<CompletionResult[]> => {
  const pos = view.state.selection.main.head
  const sources = view.state.languageDataAt<CompletionSource>('autocomplete', pos)
  const results = await Promise.all(sources.map(source => source(new CompletionContext(view.state, pos, false))))
  return results.filter((result): result is CompletionResult => result !== null)
}

const accept = (view: EditorView, result: CompletionResult, option: Completion) => {
  const apply = option.apply as (view: EditorView, option: Completion, from: number, to: number) => void
  apply(view, option, result.from, result.to ?? view.state.selection.main.head)
}

const typesOf = async (id: string) => getBlockTypes((await repo.load(id))!)
const typeCount = () => repo.types.size
const resolver = () => queryResolver(repo, workspaceId, repo.propertyDefinitions, repo.types, new Map())

describe('completion inside the query fence', () => {
  it('inserts the picked type as query text, tagging nothing and minting nothing', async () => {
    const view = await editor(valueId, fencedQuery('status=open #bo|'), true)
    const types = await typesOf(valueId)
    const before = typeCount()

    const results = await answers(view)
    // Only the query's source answers: the type tag is off inside the fence.
    expect(results).toHaveLength(1)
    const [result] = results
    const option = result!.options.find(o => o.label === 'Book' && o.detail === 'type')!
    accept(view, result!, option)

    expect(view.state.doc.toString()).toBe(fencedQuery('status=open #Book^book'))
    await repo.awaitProcessors()
    expect(await typesOf(valueId)).toEqual(types)
    expect(typeCount()).toBe(before)
  })

  it('keeps the term on the picked type when two types share its label', async () => {
    const pickedIds: unknown[] = []
    for (const index of [0, 1]) {
      const view = await editor(valueId, fencedQuery('#Bo|'), true)
      const [result] = await answers(view)
      const books = result!.options.filter(o => o.label === 'Book')
      expect(books).toHaveLength(2)
      accept(view, result!, books[index]!)
      const parsed = parseQuery(queryTextOf(view.state.doc.toString()), resolver())
      expect(parsed.errors).toEqual([])
      pickedIds.push(parsed.query.types)
    }
    expect(pickedIds.flat().sort()).toEqual(['book', 'other:book'])
  })

  it('offers a property key with = and a presence-only one without', async () => {
    const view = await editor(valueId, fencedQuery('#Book^book !st|'), true)
    const [result] = await answers(view)
    const byLabel = new Map(result!.options.map(o => [o.label, o]))
    accept(view, result!, byLabel.get('status')!)
    expect(view.state.doc.toString()).toBe(fencedQuery(`#Book^book !status^${fieldIdOf('status')}=`))

    const presence = await editor(valueId, fencedQuery('sta|'), true)
    const [presenceResult] = await answers(presence)
    accept(presence, presenceResult!, presenceResult!.options.find(o => o.label === 'stash')!)
    expect(presence.state.doc.toString()).toBe(fencedQuery(`stash^${fieldIdOf('stash')}`))
    expect(parseQuery(queryTextOf(presence.state.doc.toString()), resolver()).errors).toEqual([])
  })

  it('offers the queryable fields, never a property named like one, and the structural keys', async () => {
    const view = await editor(valueId, fencedQuery('cre|'), true)
    const [result] = await answers(view)
    const named = result!.options.filter(o => o.label === 'created')
    expect(named.map(o => o.detail)).toEqual(['field'])
    const created = named[0]!
    accept(view, result!, created)
    expect(view.state.doc.toString()).toBe(fencedQuery('created='))

    const structure = await editor(valueId, fencedQuery('und|'), true)
    const [structureResult] = await answers(structure)
    expect(structureResult!.options.map(o => o.label)).toContain('under')
  })
})

describe('completion outside the query', () => {
  it('leaves # in the query value outside its fence as ordinary tagging', async () => {
    await repo.tx(tx => tx.update(valueId, {content: 'call #bo'}), options)
    const view = await editor(valueId, 'call #bo|', true)
    const results = await answers(view)
    expect(results).toHaveLength(1)
    const option = results[0]!.options.find(o => o.label === 'Book')!
    expect(option.detail).not.toBe('type')
    accept(view, results[0]!, option)
    await vi.waitFor(async () => expect((await typesOf(valueId)).length).toBeGreaterThan(0))
  })

  it('offers nothing in a query fence of any other block', async () => {
    await repo.tx(tx => tx.update('note', {content: fencedQuery('#bo')}), options)
    const view = await editor('note', fencedQuery('#bo|'), false)
    expect(await answers(view)).toEqual([])
  })
})

describe('queryTriggerAt', () => {
  it.each([
    ['#bo', {kind: 'type', from: 0, query: 'bo'}],
    ['a=1 !#ar', {kind: 'type', from: 5, query: 'ar'}],
    ['#a|#b', {kind: 'type', from: 3, query: 'b'}],
    ['x !sta', {kind: 'key', from: 3, query: 'sta'}],
    ['#', {kind: 'type', from: 0, query: ''}],
  ])('%j', (line, trigger) => {
    expect(queryTriggerAt(line, line.length)).toEqual(trigger)
  })

  it.each([
    ['status=op'], ['rank>=3'], ['#Book^bo'], ['x#bo'], ['label="a st'], ['owner=[[Ma'], ['owner=((01'], [''], ['a '],
  ])('%j offers nothing', line => {
    expect(queryTriggerAt(line, line.length)).toBeNull()
  })

  it('offers nothing in the middle of a word', () => {
    expect(queryTriggerAt('status', 3)).toBeNull()
  })
})
