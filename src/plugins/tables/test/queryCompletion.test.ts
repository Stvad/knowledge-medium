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
const PROPERTIES = [
  user('status', codecs.string), user('stash', codecs.unsafeIdentity<unknown>()), user('created', codecs.string), user('under', codecs.string),
  user('due date', codecs.string), user('my flag', codecs.unsafeIdentity<unknown>()),
]
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
    typeSeedsFacet.of(seedType({seedKey: 'test/type/zeta', revision: 1, id: 'zeta', label: 'Zeta'}), {source: 'test'}),
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

/** An editor on `blockId` holding `doc`, the cursor at `‸`, with the extensions
 *  the renderer gives it: `asQueryValue` when it is drawn as the query's value. */
const editor = async (blockId: string, docWithCursor: string, asQueryValue: boolean) => {
  const block = repo.block(blockId)
  await block.load()
  const context = {repo, block, propertyValueSchema: asQueryValue ? queryValueSchema : undefined}
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: docWithCursor.replace('‸', ''),
      selection: {anchor: docWithCursor.indexOf('‸')},
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
    const view = await editor(valueId, fencedQuery('status=open #bo‸'), true)
    const types = await typesOf(valueId)
    const before = typeCount()

    const results = await answers(view)
    // Only the query's source answers: the type tag is off inside the fence.
    expect(results).toHaveLength(1)
    const [result] = results
    const option = result!.options.find(o => o.label === 'Book' && o.detail === 'book')!
    accept(view, result!, option)

    expect(view.state.doc.toString()).toBe(fencedQuery('status=open #Book'))
    await repo.awaitProcessors()
    expect(await typesOf(valueId)).toEqual(types)
    expect(typeCount()).toBe(before)
  })

  it('names a type by its label, and by its id where another type shares the label', async () => {
    const pickedIds: unknown[] = []
    const texts: string[] = []
    for (const index of [0, 1]) {
      const view = await editor(valueId, fencedQuery('#Bo‸'), true)
      const [result] = await answers(view)
      const books = result!.options.filter(o => o.label === 'Book')
      expect(books).toHaveLength(2)
      accept(view, result!, books[index]!)
      const parsed = parseQuery(queryTextOf(view.state.doc.toString()), resolver())
      expect(parsed.errors).toEqual([])
      pickedIds.push(parsed.query.types)
      texts.push(queryTextOf(view.state.doc.toString()))
    }
    expect(pickedIds.flat().sort()).toEqual(['book', 'other:book'])
    // `#Book` resolves to the first type with that label; the other needs its id.
    expect(texts.sort()).toEqual(['#Book', '#Book^other:book'])
  })

  it('offers a property key with = and a presence-only one without', async () => {
    const view = await editor(valueId, fencedQuery('#Book^book st‸'), true)
    const [result] = await answers(view)
    accept(view, result!, result!.options.find(o => o.label === 'status')!)
    expect(view.state.doc.toString()).toBe(fencedQuery('#Book^book status='))

    const presence = await editor(valueId, fencedQuery('sta‸'), true)
    const [presenceResult] = await answers(presence)
    accept(presence, presenceResult!, presenceResult!.options.find(o => o.label === 'stash')!)
    expect(presence.state.doc.toString()).toBe(fencedQuery('stash'))
    expect(parseQuery(queryTextOf(presence.state.doc.toString()), resolver()).errors).toEqual([])
  })

  it('after a negating ! offers only property presence', async () => {
    // `u` matches the field `updated` and the structural key `under` too.
    const view = await editor(valueId, fencedQuery('!u‸'), true)
    const [result] = await answers(view)
    expect(result!.options.map(o => [o.label, o.detail])).toEqual([['under', 'property'], ['due date', 'property'], ['status', 'property']])
    accept(view, result!, result!.options.find(o => o.label === 'status')!)
    const doc = view.state.doc.toString()
    expect(doc).toBe(fencedQuery('!status'))
    expect(parseQuery(queryTextOf(doc), resolver()).errors).toEqual([])
  })

  it('replaces the whole name being edited, keeping the operator after it', async () => {
    for (const [before, picked, after] of [
      ['#Boo‸^book status=x', 'Book', '#Book status=x'],
      [`statu‸^${fieldIdOf('status')}=open`, 'status', 'status=open'],
      ['sta‸=open', 'status', 'status=open'],
      ['st‸tus!=open', 'status', 'status!=open'],
    ] as const) {
      const view = await editor(valueId, fencedQuery(before), true)
      const [result] = await answers(view)
      accept(view, result!, result!.options.find(o => o.label === picked && o.detail !== 'other:book')!)
      expect(view.state.doc.toString()).toBe(fencedQuery(after))
    }
  })

  it('offers the queryable fields and the structural keys, but no key a property and a field share', async () => {
    const view = await editor(valueId, fencedQuery('upd‸'), true)
    const [result] = await answers(view)
    const updated = result!.options.find(o => o.label === 'updated')!
    expect(updated.detail).toBe('field')
    accept(view, result!, updated)
    expect(view.state.doc.toString()).toBe(fencedQuery('updated='))

    // A property here is named `created`, like the kernel field: the parser refuses the name either way.
    const shared = await editor(valueId, fencedQuery('cre‸'), true)
    expect(await answers(shared)).toEqual([])

    const structure = await editor(valueId, fencedQuery('und‸'), true)
    const [structureResult] = await answers(structure)
    expect(structureResult!.options.map(o => [o.detail, o.label])).toEqual([['property', 'under'], ['structure', 'under']])
    // A property named like a structural key is addressed by its id: the bare name is structure.
    accept(structure, structureResult!, structureResult!.options[0]!)
    expect(structure.state.doc.toString()).toBe(fencedQuery(`under^${fieldIdOf('under')}=`))
  })

  it('offers on one side of a | group only what can stand there', async () => {
    const [result] = await answers(await editor(valueId, fencedQuery('#Book^book | chi‸'), true))
    expect(result?.options.map(o => o.label) ?? []).not.toContain('childof')
    expect(await answers(await editor(valueId, fencedQuery('#Book^book | !st‸'), true))).toEqual([])
    expect(await answers(await editor(valueId, fencedQuery('#Book^book | !#Bo‸'), true))).toEqual([])
  })

  it('never offers the query property itself', async () => {
    const [result] = await answers(await editor(valueId, fencedQuery('tables‸'), true))
    expect(result?.options.map(o => o.label) ?? []).not.toContain(queryProp.name)
  })

  it('offers plumbing types after the others', async () => {
    const [result] = await answers(await editor(valueId, fencedQuery('#ta‸'), true))
    const labels = result!.options.map(o => o.label)
    expect(labels).toContain('Panel stack')
    expect(labels.indexOf('Zeta')).toBeLessThan(labels.indexOf('Panel stack'))
  })

  it('addresses a name needing quotes by its id wherever the quoted name alone would be a text search', async () => {
    for (const [typed, picked, insert] of [
      ['!due‸', 'due date', `!"due date"^"${fieldIdOf('due date')}"`],
      ['my‸', 'my flag', `"my flag"^"${fieldIdOf('my flag')}"`],
      ['due‸', 'due date', `"due date"^"${fieldIdOf('due date')}"=`],
    ] as const) {
      const view = await editor(valueId, fencedQuery(typed), true)
      const [result] = await answers(view)
      accept(view, result!, result!.options.find(o => o.label === picked)!)
      const text = queryTextOf(view.state.doc.toString())
      expect(text).toBe(insert)
      const parsed = parseQuery(text.endsWith('=') ? `${text}x` : text, resolver())
      expect(parsed.errors).toEqual([])
    }
  })

  it('reads the whole query before the cursor: a quote opened on an earlier line is still open', async () => {
    const view = await editor(valueId, fencedQuery('status="a\nst‸'), true)
    expect(await answers(view)).toEqual([])
  })

  it('offers nothing on the opening fence line', async () => {
    const view = await editor(valueId, '```query st‸\n\n```', true)
    expect(await answers(view)).toEqual([])
  })
})

describe('completion outside the query', () => {
  it('leaves # in the query value outside its fence as ordinary tagging', async () => {
    await repo.tx(tx => tx.update(valueId, {content: 'call #bo'}), options)
    const view = await editor(valueId, 'call #bo‸', true)
    const results = await answers(view)
    expect(results).toHaveLength(1)
    const option = results[0]!.options.find(o => o.label === 'Book')!
    expect(option.detail).not.toBe('type')
    accept(view, results[0]!, option)
    await vi.waitFor(async () => expect((await typesOf(valueId)).length).toBeGreaterThan(0))
  })

  it('offers nothing in a query fence of any other block', async () => {
    await repo.tx(tx => tx.update('note', {content: fencedQuery('#bo')}), options)
    const view = await editor('note', fencedQuery('#bo‸'), false)
    expect(await answers(view)).toEqual([])
  })
})

const trigger = (before: string, after = '') => queryTriggerAt(before, after)

describe('queryTriggerAt', () => {
  it.each([
    ['#bo', {kind: 'type', from: 0, to: 3, query: 'bo'}],
    ['a=1 !#ar', {kind: 'type', from: 5, to: 8, query: 'ar', negated: true}],
    ['#a|#b', {kind: 'type', from: 3, to: 5, query: 'b', alternative: true}],
    ['#a | sta', {kind: 'key', from: 5, to: 8, query: 'sta', alternative: true}],
    ['(#bo', {kind: 'type', from: 1, to: 4, query: 'bo', alternative: true}],
    ['x !sta', {kind: 'key', from: 3, to: 6, query: 'sta', negated: true}],
    ['#', {kind: 'type', from: 0, to: 1, query: ''}],
    ['#"Reading l', {kind: 'type', from: 0, to: 11, query: 'Reading l'}],
    ['refs=[[a]] sta', {kind: 'key', from: 11, to: 14, query: 'sta'}],
    ['refs=[[a "b]] sta', {kind: 'key', from: 14, to: 17, query: 'sta'}],
    ['a="x y" sta', {kind: 'key', from: 8, to: 11, query: 'sta'}],
  ])('%j', (before, expected) => {
    expect(trigger(before)).toEqual({negated: false, alternative: false, operatorFollows: false, ...expected})
  })

  it.each([
    ['status=op'], ['rank>=3'], ['#Book^bo'], ['x#bo'], ['x!sta'], ['label="a st'], ['owner=[[Ma'], ['owner=((01'],
    ['refs=[[My bo'], ['refs=[[a #bo'], ['owner=[my st'], ['owner=[x](((01 st'], [''], ['a '],
  ])('%j offers nothing', before => {
    expect(trigger(before)).toBeNull()
  })

  it('runs the replaced range over the rest of the name and its saved id, and sees an operator after it', () => {
    expect(trigger('sta', 'tus^def-status=open')).toMatchObject({from: 0, to: 17, query: 'sta', operatorFollows: true})
    expect(trigger('#"Read', 'ing list"^rl x')).toMatchObject({from: 0, to: 18, query: 'Read'})
    expect(trigger('st', ' rank=1')).toMatchObject({to: 2, operatorFollows: false})
  })
})
