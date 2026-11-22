// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty } from '@/data/api'
import { BLOCK_TYPE_TYPE, PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import { blockTypePropertiesProp, typesProp } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  MIN_COLUMN_WIDTH, addColumn, addPropertyToType, deleteColumn, moveColumn, resizeColumn, setColumnHidden,
} from '../columns'
import { turnIntoTable } from '../convert'
import { rowPropertyNames } from '../model'
import { tablesDataExtension } from '../dataExtension'
import { columnFieldProp, columnHiddenProp, columnWidthProp } from '../schema'

const workspaceId = 'ws-table-columns'
const authorField = 'author-definition'
const author = defineProperty('test:author', {
  codec: codecs.string, defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const options = {scope: ChangeScope.BlockDefault}

let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => { await resetTestDb(db.db) })

interface Row {id: string; content: string; properties_json: string; deleted: number}

const childrenOf = (id: string) => db.db.getAll<Row>(
  'SELECT id, content, properties_json, deleted FROM blocks WHERE parent_id = ? AND deleted = 0 AND is_field_form IS NOT 1 ORDER BY order_key, id', [id],
)
const propertiesOf = async (id: string) => {
  const [row] = await db.db.getAll<Row>('SELECT properties_json FROM blocks WHERE id = ?', [id])
  return JSON.parse(row!.properties_json) as Record<string, unknown>
}
/** Every row and value block under the host, as stored, for "untouched" checks. */
const rowsSnapshot = () => db.db.getAll<Row>(
  `WITH RECURSIVE under(id) AS (SELECT id FROM blocks WHERE parent_id = 'host' AND id IN ('dune', 'emma')
     UNION ALL SELECT b.id FROM blocks b JOIN under ON b.parent_id = under.id)
   SELECT b.id, b.content, b.properties_json, b.deleted FROM blocks b JOIN under USING (id) ORDER BY b.id`,
)

/** A table over two rows whose view has a title column and an author column. */
const setup = async () => {
  await db.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
      VALUES (?, 'test', 'test-user', 1, 1, 'none', 'children')`,
    [workspaceId],
  )
  const {repo} = createTestRepo({db: db.db, extensions: [tablesDataExtension]})
  repo.setActiveWorkspaceId(workspaceId)
  repo.setRuntimeContributions(projectedPropertyDefinitionsFacet, 'test-definition', [{
    metadata: {
      fieldId: authorField, workspaceId, createdAt: 1, name: author.name,
      changeScope: author.changeScope, hidden: false, origin: 'user',
    },
    schema: author,
  }], {workspaceId})
  await repo.tx(async tx => {
    await tx.create({id: authorField, workspaceId, parentId: null, orderKey: 'a0', content: 'author', properties: {types: [PROPERTY_SCHEMA_TYPE]}})
    await tx.create({id: 'host', workspaceId, parentId: null, orderKey: 'a1', content: 'Reading list'})
    await tx.create({id: 'dune', workspaceId, parentId: 'host', orderKey: 'a0', content: 'Dune'})
    await tx.create({id: 'emma', workspaceId, parentId: 'host', orderKey: 'a1', content: 'Emma'})
    await tx.setProperty('emma', author, 'Austen')
    await tx.setProperty('dune', author, 'Herbert')
  }, options)
  await turnIntoTable(repo, 'host')
  const [view] = await childrenOf('host')
  const [title, authorColumn] = await childrenOf(view!.id)
  return {repo, viewId: view!.id, titleId: title!.id, authorId: authorColumn!.id}
}

describe('column gestures', () => {
  it('suggests the rows’ own properties for a new column, the most common first', async () => {
    const {repo} = await setup()
    // Alphabetically ahead of the author, but on one row of two. Only the
    // projection is read, so a raw write is enough.
    await db.db.execute(`UPDATE blocks SET properties_json = json_set(properties_json, '$."test:a-year"', '1815') WHERE id = 'emma'`)
    expect(await rowPropertyNames(repo.block('host'), workspaceId, null)).toEqual([author.name, 'test:a-year'])
  })

  it('resize writes the width once, rounded, and never narrower than the minimum', async () => {
    const {repo, authorId} = await setup()
    const before = await rowsSnapshot()
    await resizeColumn(repo, authorId, 211.6)
    expect((await propertiesOf(authorId))[columnWidthProp.name]).toBe(212)
    await resizeColumn(repo, authorId, 3)
    expect((await propertiesOf(authorId))[columnWidthProp.name]).toBe(MIN_COLUMN_WIDTH)

    await repo.undo()
    expect((await propertiesOf(authorId))[columnWidthProp.name]).toBe(212)
    expect(await rowsSnapshot()).toEqual(before)
  })

  it('reorder is one move among the view’s columns, undone in one step', async () => {
    const {repo, viewId, titleId, authorId} = await setup()
    const before = await rowsSnapshot()
    await moveColumn(repo, authorId, {side: 'before', columnId: titleId})
    expect((await childrenOf(viewId)).map(column => column.id)).toEqual([authorId, titleId])

    await repo.undo()
    expect((await childrenOf(viewId)).map(column => column.id)).toEqual([titleId, authorId])
    expect(await rowsSnapshot()).toEqual(before)
  })

  it('hiding flags the column and keeps its block; showing unsets the flag', async () => {
    const {repo, viewId, authorId} = await setup()
    await resizeColumn(repo, authorId, 300)
    await setColumnHidden(repo, authorId, true)
    expect((await propertiesOf(authorId))[columnHiddenProp.name]).toBe(true)
    expect((await childrenOf(viewId)).map(column => column.id)).toContain(authorId)

    await setColumnHidden(repo, authorId, false)
    const shown = await propertiesOf(authorId)
    expect(columnHiddenProp.name in shown).toBe(false)
    expect(shown[columnWidthProp.name]).toBe(300)

    await repo.undo()
    expect((await propertiesOf(authorId))[columnHiddenProp.name]).toBe(true)
  })

  it('delete removes the column block only, and the rows keep their values', async () => {
    const {repo, viewId, titleId, authorId} = await setup()
    const before = await rowsSnapshot()
    expect(await deleteColumn(repo, authorId)).toBe('deleted')
    expect((await childrenOf(viewId)).map(column => column.id)).toEqual([titleId])
    expect(await rowsSnapshot()).toEqual(before)
    expect((await propertiesOf('emma'))[author.name]).toBe('Austen')

    await repo.undo()
    expect((await childrenOf(viewId)).map(column => column.id)).toEqual([titleId, authorId])
  })

  it('delete refuses a column with blocks nested under it, writing nothing', async () => {
    const {repo, viewId, titleId, authorId} = await setup()
    await repo.tx(tx => tx.create({id: 'note', workspaceId, parentId: authorId, orderKey: 'z0', content: 'a note'}), options)
    expect(await deleteColumn(repo, authorId)).toBe('nested')
    expect((await childrenOf(viewId)).map(column => column.id)).toEqual([titleId, authorId])
    expect((await childrenOf(authorId)).map(child => child.id)).toEqual(['note'])
  })

  it('add creates a last column showing the property', async () => {
    const {repo, viewId, titleId, authorId} = await setup()
    const added = await addColumn(repo, viewId, authorField)
    expect((await childrenOf(viewId)).map(column => column.id)).toEqual([titleId, authorId, added])
    expect((await propertiesOf(added))[columnFieldProp.name]).toBe(authorField)
  })
})

describe('addPropertyToType', () => {
  const addTypeBlock = async (repo: Awaited<ReturnType<typeof setup>>['repo'], properties: Record<string, unknown> = {}) => {
    await repo.tx(async tx => {
      await tx.create({
        id: 'book-type', workspaceId, parentId: null, orderKey: 'a2', content: 'book',
        properties: {[typesProp.name]: [BLOCK_TYPE_TYPE], ...properties},
      })
    }, options)
  }

  it('appends the property to the type’s declared properties once', async () => {
    const {repo} = await setup()
    await addTypeBlock(repo)
    expect(await addPropertyToType(repo, 'book-type', authorField)).toBe(true)
    expect((await propertiesOf('book-type'))[blockTypePropertiesProp.name]).toEqual([authorField])
    expect(await addPropertyToType(repo, 'book-type', authorField)).toBe(false)
    expect((await propertiesOf('book-type'))[blockTypePropertiesProp.name]).toEqual([authorField])

    await repo.undo()
    expect((await propertiesOf('book-type'))[blockTypePropertiesProp.name] ?? []).toEqual([])
  })

  it('refuses a block that is not a property definition, writing nothing', async () => {
    const {repo} = await setup()
    await addTypeBlock(repo)
    expect(await addPropertyToType(repo, 'book-type', 'emma')).toBe(false)
    expect((await propertiesOf('book-type'))[blockTypePropertiesProp.name] ?? []).toEqual([])
  })

  it('refuses a block that is not a type', async () => {
    const {repo} = await setup()
    expect(await addPropertyToType(repo, 'emma', authorField)).toBe(false)
    expect(blockTypePropertiesProp.name in await propertiesOf('emma')).toBe(false)
  })
})
