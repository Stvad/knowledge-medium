// @vitest-environment node
/**
 * `createTypedChild` exists to make the granular shape (one block per
 * record, typed, composable) as cheap to write as the JSON-blob shortcut.
 * These tests pin the properties that make it worth reaching for: the block
 * lands typed, its values go through their codecs, several types compose,
 * and the whole thing is one atomic unit of the caller's transaction.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, propertyValue, seedProperty, seedType } from '@/data/api'
import type { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import { getBlockTypes } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTypedChild } from '@/data/typedRecords'

const weightProp = seedProperty({
  seedKey: 'test/property/rec-weight',
  revision: 1,
  name: 'rec:weight',
  preset: 'number',
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

const doneProp = seedProperty({
  seedKey: 'test/property/rec-done',
  revision: 1,
  name: 'rec:done',
  preset: 'boolean',
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

const recordType = seedType({
  seedKey: 'test/type/rec',
  revision: 1,
  id: 'rec-entry',
  label: 'Record',
  properties: [weightProp],
})

const companionType = seedType({
  seedKey: 'test/type/rec-companion',
  revision: 1,
  id: 'rec-companion',
  label: 'Companion',
  properties: [doneProp],
})

let sharedDb: TestDb
let repo: Repo
let cache: BlockCache

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  const created = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [
      definitionSeedsFacet.of(weightProp, {source: 'test'}),
      definitionSeedsFacet.of(doneProp, {source: 'test'}),
      typeSeedsFacet.of(recordType, {source: 'test'}),
      typeSeedsFacet.of(companionType, {source: 'test'}),
    ],
  })
  repo = created.repo
  cache = created.cache
  repo.setActiveWorkspaceId('ws-1')
  await repo.tx(async tx => {
    await tx.create({id: 'parent', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'Parent'})
  }, {scope: ChangeScope.BlockDefault})
})

describe('createTypedChild', () => {
  it('creates a typed child with codec-encoded properties in one call', async () => {
    const id = await repo.tx(
      tx => createTypedChild(repo, tx, {
        parentId: 'parent',
        content: '135lb × 8',
        types: [recordType.id],
        properties: [propertyValue(weightProp, 135)],
      }),
      {scope: ChangeScope.BlockDefault, description: 'record'},
    )

    const block = cache.getSnapshot(id)!
    expect(block.parentId).toBe('parent')
    expect(block.content).toBe('135lb × 8')
    expect(getBlockTypes(block)).toEqual([recordType.id])
    expect(repo.block(id).peekProperty(weightProp)).toBe(135)
  })

  it('composes several types on one record', async () => {
    const id = await repo.tx(
      tx => createTypedChild(repo, tx, {
        parentId: 'parent',
        types: [recordType.id, companionType.id],
        properties: [propertyValue(weightProp, 45), propertyValue(doneProp, true)],
      }),
      {scope: ChangeScope.BlockDefault},
    )
    expect(getBlockTypes(cache.getSnapshot(id)!)).toEqual([recordType.id, companionType.id])
    expect(repo.block(id).peekProperty(doneProp)).toBe(true)
  })

  it('honours an explicit id and position so deterministic-id upserts work', async () => {
    const secondId = await repo.tx(tx => createTypedChild(repo, tx, {
      parentId: 'parent', types: [recordType.id], content: 'second',
    }), {scope: ChangeScope.BlockDefault})
    const firstId = await repo.tx(tx => createTypedChild(repo, tx, {
      parentId: 'parent', id: 'pinned-id', content: 'first', types: [recordType.id],
      position: {kind: 'first'},
    }), {scope: ChangeScope.BlockDefault})

    expect(firstId).toBe('pinned-id')
    const rows = await sharedDb.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      ['parent'],
    )
    expect(rows.map(r => r.id)).toEqual(['pinned-id', secondId])
  })

  it('rolls the whole record back with the caller\'s transaction', async () => {
    await expect(repo.tx(async tx => {
      await createTypedChild(repo, tx, {
        parentId: 'parent', id: 'doomed', types: [recordType.id],
        properties: [propertyValue(weightProp, 95)],
      })
      throw new Error('caller failed after the record was created')
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow('caller failed')

    const rows = await sharedDb.db.getAll<{id: string}>('SELECT id FROM blocks WHERE id = ?', ['doomed'])
    expect(rows).toEqual([])
  })
})
