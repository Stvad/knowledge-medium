// @vitest-environment node
/** The query slice against a real workspace: the query read from its value,
 *  rows created with what the query implies, the row source's exclusions, and
 *  the view's sort. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty, type AnyPropertySchema } from '@/data/api'
import { projectedPropertyDefinitionsFacet, queryableFieldsFacet } from '@/data/facets'
import { materializePropertySeeds, propertyDefinitionBlockId } from '@/data/definitionSeeds'
import { getBlockTypes } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { turnIntoTable } from '../convert'
import { referencesDataExtension } from '@/plugins/references/dataExtension'
import { tablesDataExtension } from '../dataExtension'
import { rowQuery, type TableColumn } from '../model'
import { createQueryRow, rowBackfill } from '../query/backfill'
import { parseQuery } from '../query/parse'
import { openQueryValue } from '../query/queryValue'
import { queryResolver } from '../query/source'
import { COLUMN_TYPE, VIEW_TYPE, queryProp } from '../schema'
import { nextSort, sortOrder, writeSort } from '../sort'

const workspaceId = 'ws-query-slice'
const options = {scope: ChangeScope.BlockDefault}
const PARENT = '0190a0c0-0000-7000-8000-0000000000aa'
const OWNER = '0190a0c0-0000-7000-8000-0000000000bb'

const user = (name: string, codec: AnyPropertySchema['codec']) =>
  defineProperty(name, {codec, defaultValue: undefined, changeScope: ChangeScope.BlockDefault}) as AnyPropertySchema
const PROPERTIES = [
  user('publish', codecs.enum(['article', 'note'])),
  user('rank', codecs.number),
  user('due', codecs.date),
  user('tags', codecs.list(codecs.string)),
  user('owner', codecs.ref()),
  user('state', codecs.string),
]
const prop = (name: string) => PROPERTIES.find(p => p.name === name)!
const fieldIdOf = (name: string) => `def-${name}`

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(async () => { await repo.awaitProcessors() })
beforeEach(async () => {
  await resetTestDb(db.db)
  await db.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
      VALUES (?, 'test', 'test-user', 1, 1, 'none', 'children')`, [workspaceId])
  ;({repo} = createTestRepo({db: db.db, extensions: [tablesDataExtension, referencesDataExtension]}))
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
    await tx.create({id: 'host', workspaceId, parentId: null, orderKey: 'h', content: 'Articles'})
    await tx.create({id: PARENT, workspaceId, parentId: null, orderKey: 'p', content: 'Inbox'})
    await tx.create({id: OWNER, workspaceId, parentId: null, orderKey: 'o', content: 'Mary'})
  }, options)
})

const parse = (text: string) =>
  parseQuery(text, queryResolver(repo, workspaceId, repo.propertyDefinitions, repo.types, new Map()), {selfId: 'host'})
const rows = (text: string) => repo.query.typedBlockIds(rowQuery('host', workspaceId, parse(text).query)).load()

describe('a new row in a query table', () => {
  const QUERY = `#page publish=article rank=3 due=2026-01-05 tags=x owner=((${OWNER})) state!=done rank>1 childof=((${PARENT}))`

  it('carries what the query implies, so the query selects it', async () => {
    const {terms, errors} = parse(QUERY)
    expect(errors).toEqual([])
    const id = await createQueryRow(repo, 'host', rowBackfill(terms))

    const row = await db.db.get<{parent_id: string; properties_json: string}>('SELECT parent_id, properties_json FROM blocks WHERE id = ?', [id])
    expect(row.parent_id).toBe(PARENT)
    const properties = JSON.parse(row.properties_json) as Record<string, unknown>
    expect(getBlockTypes({properties})).toContain('page')
    expect(properties).toMatchObject({publish: 'article', rank: 3, due: '2026-01-05T00:00:00.000Z', tags: ['x'], owner: OWNER})
    expect(properties).not.toHaveProperty('state')
    await repo.awaitProcessors()
    expect(await rows(QUERY)).toContain(id)
  })

  it('is created under the host when the query names no parent', async () => {
    const id = await createQueryRow(repo, 'host', rowBackfill(parse('publish=article').terms))
    expect((await db.db.get<{parent_id: string}>('SELECT parent_id FROM blocks WHERE id = ?', [id])).parent_id).toBe('host')
  })

  it('is one undo step', async () => {
    const id = await createQueryRow(repo, 'host', rowBackfill(parse(QUERY).terms))
    await repo.undo()
    expect(await db.db.get<{deleted: number}>('SELECT deleted FROM blocks WHERE id = ?', [id])).toEqual({deleted: 1})
  })

  it('back-fills nothing from ranges, negations, presence or an or-group', () => {
    expect(rowBackfill(parse('rank>1 state!=done tags (publish=article | rank=2)').terms))
      .toEqual({parentId: undefined, types: [], values: []})
  })
})

describe('query rows', () => {
  it('never lists the table itself or any table’s view and column blocks', async () => {
    await turnIntoTable(repo, 'host')
    await repo.tx(async tx => {
      await tx.create({id: 'other', workspaceId, parentId: null, orderKey: 'x', content: 'Other table'})
      await tx.create({id: 'row', workspaceId, parentId: PARENT, orderKey: 'r', content: 'A row'})
    }, options)
    await turnIntoTable(repo, 'other')
    const machinery = await db.db.getAll<{id: string}>(
      `SELECT block_id AS id FROM block_types WHERE type IN (?, ?)`, [VIEW_TYPE, COLUMN_TYPE])
    expect(machinery.length).toBeGreaterThan(0)
    await repo.tx(async tx => {
      for (const id of ['host', 'row', ...machinery.map(row => row.id)]) await tx.setProperty(id, prop('publish'), 'article')
    }, options)
    expect(await rows('publish=article')).toEqual(['row'])
  })
})

describe('sort', () => {
  const column = (id: string, fieldId: string | null): TableColumn => ({id, fieldId, width: undefined, hidden: false, label: ''})
  const columns = [column('c-title', null), column('c-rank', fieldIdOf('rank')), column('c-tags', fieldIdOf('tags')), column('c-owner', fieldIdOf('owner'))]
  const schemas = [undefined, prop('rank'), prop('tags'), prop('owner')]

  it('cycles ascending, descending, unsorted on one column, and restarts on another', () => {
    expect(nextSort(undefined, 'c-rank')).toEqual({columnId: 'c-rank', direction: 'asc'})
    expect(nextSort({columnId: 'c-rank', direction: 'asc'}, 'c-rank')).toEqual({columnId: 'c-rank', direction: 'desc'})
    expect(nextSort({columnId: 'c-rank', direction: 'desc'}, 'c-rank')).toBeUndefined()
    expect(nextSort({columnId: 'c-rank', direction: 'desc'}, 'c-other')).toEqual({columnId: 'c-other', direction: 'asc'})
  })

  it.each([
    ['c-rank', {property: 'rank', direction: 'desc'}],
    ['c-tags', undefined],
    ['c-owner', undefined],
    ['c-title', undefined],
    ['c-gone', undefined],
  ])('orders by %s as %j', (columnId, order) => {
    expect(sortOrder({columnId, direction: 'desc'}, columns, schemas, new Set(['created']))).toEqual(order)
  })

  it('does not sort by a property named like a queryable field, which the engine refuses', () => {
    expect(sortOrder({columnId: 'c-rank', direction: 'asc'}, columns, schemas, new Set(['rank']))).toBeUndefined()
  })

  it('stores the column and direction on the view, each change one undo step', async () => {
    await turnIntoTable(repo, 'host')
    const [view] = await repo.query.typedBlockIds({workspaceId, parentId: 'host', types: [VIEW_TYPE]}).load()
    const [firstColumn] = await repo.query.typedBlockIds({workspaceId, parentId: view!, types: [COLUMN_TYPE]}).load()
    const stored = async () => {
      const row = await db.db.get<{properties_json: string}>('SELECT properties_json FROM blocks WHERE id = ?', [view!])
      const properties = JSON.parse(row.properties_json) as Record<string, unknown>
      return [properties['tables:viewSortColumn'], properties['tables:viewSortDirection']]
    }
    await writeSort(repo, view!, {columnId: firstColumn!, direction: 'asc'})
    await writeSort(repo, view!, {columnId: firstColumn!, direction: 'desc'})
    expect(await stored()).toEqual([firstColumn, 'desc'])
    await repo.undo()
    expect(await stored()).toEqual([firstColumn, 'asc'])
    await writeSort(repo, view!, undefined)
    expect(await stored()).toEqual([undefined, undefined])
  })
})

describe('openQueryValue', () => {
  const queryFieldId = async () => {
    await materializePropertySeeds(repo, workspaceId, [queryProp])
    return propertyDefinitionBlockId(workspaceId, queryProp.seedKey)
  }
  const valueContents = () => db.db.getAll<{content: string}>(
    `SELECT v.content FROM blocks f JOIN blocks v ON v.parent_id = f.id
      WHERE f.parent_id = 'host' AND f.is_field_form = 1 AND f.deleted = 0 AND v.deleted = 0`)

  it('gives a host with no query an empty value', async () => {
    await openQueryValue(repo, 'host', await queryFieldId())
    expect(await valueContents()).toEqual([{content: ''}])
  })

  it('opens a value the host already holds without rewriting it, projected or not', async () => {
    const fieldId = await queryFieldId()
    // Raw rows: a value whose projection has not run yet, as after sync arrival.
    await db.db.writeTransaction(async tx => {
      for (const [id, parent, content, fieldForm] of [
        ['query-field', 'host', `::((${fieldId}))`, 1], ['query-value', 'query-field', 'keep=me', null],
      ] as const) {
        await tx.execute(
          `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json, references_json,
            created_at, updated_at, user_updated_at, created_by, updated_by, deleted, is_field_form, reference_target_id)
            VALUES (?, ?, ?, 'a0', ?, '{}', '[]', 1, 1, 1, 'u', 'u', 0, ?, ?)`,
          [id, workspaceId, parent, content, fieldForm, fieldForm ? fieldId : null])
      }
    })
    expect(await openQueryValue(repo, 'host', fieldId)).toBe('query-value')
    expect(await valueContents()).toEqual([{content: 'keep=me'}])
  })
})

describe('queryResolver fields', () => {
  it('tells the kernel timestamps from a plugin field with its own encoder', () => {
    const encode = (operand: unknown) => codecs.number.decode(operand)
    repo.setRuntimeContributions(queryableFieldsFacet, 'test', [{
      name: 'test:score', value: alias => ({sql: `${alias}.created_at`, params: []}), encode,
      dependencies: [ws => ({kind: 'workspace', workspaceId: ws})],
    }], {workspaceId})
    const resolver = queryResolver(repo, workspaceId, repo.propertyDefinitions, repo.types, new Map())
    expect(resolver.field('created')).toEqual({kind: 'instant'})
    expect(resolver.field('updated')).toEqual({kind: 'instant'})
    expect(resolver.field('test:score')).toEqual({kind: 'value', encode})
    expect(resolver.field('nope')).toBeUndefined()
  })
})
