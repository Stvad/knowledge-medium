import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import {definitionSeedsFacet} from '@/data/facets'
import {seedProperty} from '@/data/propertySeeds'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import {createInlineProperty} from '@/utils/inlinePropertyCreation'

const note = seedProperty({seedKey: 'test/property/note', revision: 1, name: 'test:note', preset: 'string', changeScope: ChangeScope.BlockDefault})
const tags = seedProperty({seedKey: 'test/property/tags', revision: 1, name: 'test:tags', preset: 'string-list', changeScope: ChangeScope.BlockDefault})
let h: TestDb
let repo: Repo
beforeAll(async () => { h = await createTestDb() })
afterAll(async () => { await h.cleanup() })
beforeEach(async () => {
  await resetTestDb(h.db)
  repo = createTestRepo({db: h.db, newId: () => crypto.randomUUID(), extensions: [definitionSeedsFacet.of(note), definitionSeedsFacet.of(tags)]}).repo
  repo.setActiveWorkspaceId('ws')
  await h.db.execute("INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration) VALUES ('ws', 'Test', 'user', 1, 1, 'none', 'children')")
  await repo.tx(async tx => {
    await tx.create({id: 'owner', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'Owner'})
    await tx.create({id: 'source', workspaceId: 'ws', parentId: 'owner', orderKey: 'a0', content: '::'})
  }, {scope: ChangeScope.BlockDefault})
  repo.undoManager.clear()
})
const children = (id: string) => repo.query.children({id, propertyChildren: 'all'}).load()

describe('createInlineProperty', () => {
  it('converts the same block and creates one value in one transaction and undo step', async () => {
    const result = await createInlineProperty(repo.block('owner'), note, repo.block('source'))
    expect(result?.fieldId).toBe('source')
    expect(await children('owner')).toHaveLength(1)
    expect(await children('source')).toHaveLength(1)
    expect(repo.block('source').peek()?.content).toMatch(/^::\(\([a-f0-9-]+\)\)$/)
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(1)
    const events = await h.db.getAll<{tx_id: string}>('SELECT DISTINCT tx_id FROM row_events WHERE block_id IN (?, ?) AND tx_id IS NOT NULL', ['source', result!.valueId])
    // The scaffold's initial write belongs to the setup; its conversion and value share the final tx.
    expect(events).toHaveLength(2)
    expect(await repo.undo()).toBe(true)
    expect(repo.block('source').peek()?.content).toBe('::')
    expect(await children('source')).toEqual([])
  })

  it('returns an existing scalar value without writing or changing the typed block', async () => {
    const first = await createInlineProperty(repo.block('owner'), note)
    repo.undoManager.clear()
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    expect(await createInlineProperty(repo.block('owner'), note, repo.block('source'))).toEqual(first)
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(0)
  })

  it('adds a member to an existing list instead of another field row', async () => {
    const first = await createInlineProperty(repo.block('owner'), tags)
    const next = await createInlineProperty(repo.block('owner'), tags, repo.block('source'))
    expect(next?.fieldId).toBe(first?.fieldId)
    expect(next?.valueId).not.toBe(first?.valueId)
    expect(await children(first!.fieldId)).toHaveLength(2)
    expect(repo.block('source').peek()?.content).toBe('::')
  })

  it.each(['content', 'children', 'properties', 'moved', 'deleted'])('refuses a source changed while the picker was open: %s', async kind => {
    if (kind === 'content') await repo.block('source').setContent('keep this')
    if (kind === 'children') await repo.mutate.createChild({parentId: 'source', content: 'keep child'})
    if (kind === 'properties') await repo.block('source').set(note, 'keep property')
    if (kind === 'moved') await repo.tx(tx => tx.move('source', {parentId: null, orderKey: 'a1'}), {scope: ChangeScope.BlockDefault})
    if (kind === 'deleted') await repo.tx(tx => tx.delete('source'), {scope: ChangeScope.BlockDefault})
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    expect(await createInlineProperty(repo.block('owner'), note, repo.block('source'))).toBeNull()
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })
})
