// @vitest-environment node

import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  ChangeScope, PropertySchemaIdentityError, codecs, defineProperty, propertyValue,
} from '@/data/api'
import {projectedPropertyDefinitionsFacet} from '@/data/facets'
import {typesProp} from '@/data/properties'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'

const WS = 'ws-write-integrity'
const FIELD = 'field-write-integrity-status'
const status = defineProperty('test:status', {
  codec: codecs.string, defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const unknown = defineProperty('test:unregistered', {
  codec: codecs.string, defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const opts = {scope: ChangeScope.BlockDefault}
let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => { await resetTestDb(db.db) })

const setup = async (mode: 'cell' | 'children' = 'children') => {
  await db.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
      encryption_mode, properties_migration) VALUES (?, 'test', 'user-1', 1, 1, 'none', ?)`,
    [WS, mode],
  )
  const {repo} = createTestRepo({db: db.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  repo.setRuntimeContributions(projectedPropertyDefinitionsFacet, 'test-status', [{
    metadata: {
      fieldId: FIELD, workspaceId: WS, createdAt: 1, name: status.name,
      changeScope: status.changeScope, hidden: false, origin: 'user',
    },
    schema: status,
  }], {workspaceId: WS})
  expect(repo.activeWorkspaceId).toBe(WS)
  expect(repo.propertySchemaResolverFor(WS).resolveBoundary(unknown)).toEqual({
    status: 'available', schema: unknown,
  })
  return repo
}

const blockData = (id: string) => ({id, workspaceId: WS, parentId: null, orderKey: id})
const row = (id: string) => db.db.getOptional<{properties_json: string; content: string}>(
  'SELECT properties_json, content FROM blocks WHERE id = ?', [id],
)
const values = () => db.db.getAll<{content: string}>(
  `SELECT v.content FROM blocks f JOIN blocks v ON v.parent_id = f.id
   WHERE f.parent_id = 'target' AND f.reference_target_id = ?
     AND f.is_field_form = 1 AND f.deleted = 0 AND v.deleted = 0 ORDER BY v.order_key`,
  [FIELD],
)

describe('property write integrity in the active workspace', () => {
  it('rejects an unresolved typed write before running its updater', async () => {
    const repo = await setup()
    await repo.tx(tx => tx.create(blockData('target')), opts)
    const updater = vi.fn(() => 'value')
    await expect(repo.block('target').set(unknown, updater))
      .rejects.toBeInstanceOf(PropertySchemaIdentityError)
    expect(updater).not.toHaveBeenCalled()
    expect(JSON.parse((await row('target'))!.properties_json)).toEqual({})
  })

  it('rolls back the new owner and all batch values when a definition is missing', async () => {
    const repo = await setup()
    await expect(repo.tx(async tx => {
      await tx.create(blockData('target'))
      await tx.setProperties('target', {set: [
        propertyValue(status, 'known'), propertyValue(unknown, 'missing'),
      ]})
    }, opts)).rejects.toBeInstanceOf(PropertySchemaIdentityError)
    expect(await row('target')).toBeNull()
    expect(await db.db.getAll('SELECT id FROM blocks')).toEqual([])
  })

  it('keeps handle-based reads working without a registry while refusing children-mode writes', async () => {
    await setup()
    const {repo} = createTestRepo({db: db.db, user: {id: 'user-1'}, installKernelRuntime: false})
    repo.setActiveWorkspaceId(WS)
    expect(repo.propertySchemaResolverFor(WS).resolveBoundary(typesProp)).toEqual({
      status: 'available', schema: typesProp,
    })
    await repo.tx(tx => tx.create(blockData('target')), opts)
    await db.db.writeTransaction(tx => tx.execute(
      'UPDATE blocks SET properties_json = ? WHERE id = ?',
      [JSON.stringify({types: ['page']}), 'target'],
    ))
    await expect(repo.tx(tx => tx.getProperty('target', typesProp), opts)).resolves.toEqual(['page'])
    await expect(repo.tx(tx => tx.setProperty('target', typesProp, ['map']), opts))
      .rejects.toMatchObject({name: 'PropertySchemaIdentityError', reason: 'registry-not-workspace-keyed'})
    expect(JSON.parse((await row('target'))!.properties_json)).toEqual({types: ['page']})
  })

  it.each(['create', 'createMany', 'createOrGet'] as const)(
    'rejects unresolved properties supplied to %s', async method => {
      const repo = await setup()
      const data = {...blockData('target'), properties: {[unknown.name]: 'value'}}
      await expect(repo.tx(async tx => {
        if (method === 'createMany') await tx.createMany([data])
        else await tx[method](data)
      }, opts)).rejects.toBeInstanceOf(PropertySchemaIdentityError)
      expect(await row('target')).toBeNull()
    },
  )

  it('rejects newly added and changed unresolved bag values while preserving old orphans', async () => {
    const repo = await setup()
    await repo.tx(tx => tx.create(blockData('target')), opts)
    await db.db.writeTransaction(tx => tx.execute(
      'UPDATE blocks SET properties_json = ? WHERE id = ?',
      [JSON.stringify({[unknown.name]: 'old'}), 'target'],
    ))
    await repo.tx(tx => tx.update('target', {content: 'edited'}), opts)
    await repo.tx(tx => tx.update('target', {
      properties: {[unknown.name]: 'old', [status.name]: 'known'},
    }), opts)
    expect(await values()).toEqual([{content: 'known'}])
    await expect(repo.tx(tx => tx.update('target', {
      properties: {[unknown.name]: 'changed', [status.name]: 'known'},
    }), opts)).rejects.toBeInstanceOf(PropertySchemaIdentityError)
    expect(JSON.parse((await row('target'))!.properties_json)).toEqual({
      [unknown.name]: 'old', [status.name]: 'known',
    })
    await repo.tx(tx => tx.update('target', {properties: {[status.name]: 'known'}}), opts)
    expect(JSON.parse((await row('target'))!.properties_json)).toEqual({[status.name]: 'known'})
  })

  it('writes known bag values with children even without the deferred materializer', async () => {
    const repo = await setup()
    repo.__setSameTxProcessorsForTesting([])
    await repo.tx(tx => tx.create({...blockData('target'), properties: {[status.name]: 'first'}}), opts)
    expect(await values()).toEqual([{content: 'first'}])
    await repo.tx(tx => tx.update('target', {properties: {[status.name]: 'second'}}), opts)
    expect(await values()).toEqual([{content: 'second'}])
    await repo.tx(tx => tx.update('target', {properties: {}}), opts)
    expect(await values()).toEqual([])
  })

  it('rejects an invalid bag before inserting even when the caller handles the error', async () => {
    const repo = await setup()
    await repo.tx(async tx => {
      await expect(tx.create({...blockData('invalid'), properties: {[status.name]: 42}}))
        .rejects.toThrow(/Cannot materialize property/)
      await tx.create(blockData('survivor'))
    }, opts)
    expect(await row('invalid')).toBeNull()
    expect(await row('survivor')).not.toBeNull()
  })

  it('retains cell-mode writes without a materialized definition', async () => {
    const repo = await setup('cell')
    await repo.tx(async tx => {
      await tx.create(blockData('target'))
      await tx.setProperty('target', unknown, 'value')
    }, opts)
    expect(JSON.parse((await row('target'))!.properties_json)).toEqual({[unknown.name]: 'value'})
  })
})
