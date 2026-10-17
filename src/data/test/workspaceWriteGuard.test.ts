// @vitest-environment node

import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  ChangeScope,
  DeterministicIdCrossWorkspaceError,
  WorkspaceMismatchError,
  propertyValue,
  type Tx,
} from '@/data/api'
import {aliasesProp} from '@/data/properties'
import {createTypedChild} from '@/data/typedRecords'
import {createOrFindPlace} from '@/plugins/geo/createOrFindPlace'
import {createTestDb, resetTestDb, type TestDb} from './createTestDb'
import {createTestRepo} from './createTestRepo'
import type {Repo} from '@/data/repo'

const OPEN = 'ws-open'
const CLOSED = 'ws-closed'
const scope = ChangeScope.BlockDefault
const refusal = /workspace registry.*not loaded/i
const mintBlockId = vi.fn(() => crypto.randomUUID())
let db: TestDb
let repo: Repo

const newBlock = (id: string, workspaceId = CLOSED) => ({
  id, workspaceId, parentId: null, orderKey: 'a0', content: id,
})

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, newId: mintBlockId}).repo
  // Bootstrap before any workspace registry has been loaded.
  expect(repo.propertyDefinitions).toBeNull()
  await repo.tx(async tx => {
    await tx.create(newBlock('closed-root'))
    await tx.create(newBlock('closed-deleted'))
    await tx.delete('closed-deleted')
    await tx.create(newBlock('closed-with-alias'))
    await tx.setProperty('closed-with-alias', aliasesProp, ['present'])
  }, {scope})
  await repo.tx(tx => tx.create(newBlock('open-occupant', OPEN)), {scope})
  repo.setActiveWorkspaceId(OPEN)
  await repo.whenPropertyDefinitionsReady(OPEN)
  expect(repo.propertyDefinitions?.workspaceId).toBe(OPEN)
})

describe('transaction workspace registry guard', () => {
  const writes: [string, (tx: Tx) => Promise<unknown>][] = [
    ['create', tx => tx.create(newBlock('new'))],
    ['createMany', tx => tx.createMany([newBlock('new')])],
    ['createOrGet insert', tx => tx.createOrGet(newBlock('new'))],
    ['update', tx => tx.update('closed-root', {content: 'changed'})],
    ['delete', tx => tx.delete('closed-root')],
    ['restore', tx => tx.restore('closed-deleted')],
    ['setProperty', tx => tx.setProperty('closed-root', aliasesProp, ['changed'])],
    ['unsetProperty', tx => tx.unsetProperty('closed-with-alias', aliasesProp)],
    ['setProperties', tx => tx.setProperties('closed-root', {
      set: [propertyValue(aliasesProp, ['changed'])],
    })],
    ['stampReferenceTarget', tx => tx.stampReferenceTarget('closed-root', 'field', true)],
    ['move', tx => tx.move('closed-root', {parentId: null, orderKey: 'a1'})],
  ]

  it.each(writes)('refuses %s in a closed workspace before changing rows', async (_, write) => {
    const before = await db.db.getAll('SELECT * FROM blocks ORDER BY id')
    await expect(repo.tx(write, {scope})).rejects.toThrow(refusal)
    expect(await db.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })

  it('refuses a closed-workspace batch before minting block ids', async () => {
    mintBlockId.mockClear()
    await expect(repo.tx(tx => tx.createMany([{
      workspaceId: CLOSED, parentId: null, orderKey: 'a0',
    }]), {scope})).rejects.toThrow(refusal)
    expect(mintBlockId).not.toHaveBeenCalled()
  })

  it('allows property schema resolution for a retained previous workspace', async () => {
    repo.setActiveWorkspaceId(CLOSED)
    await repo.whenPropertyDefinitionsReady(CLOSED)
    repo.setActiveWorkspaceId(OPEN)
    await repo.whenPropertyDefinitionsReady(OPEN)
    const expected = repo.propertySchemaResolverFor(CLOSED).resolve(aliasesProp)
    expect(expected.status).toBe('resolved')
    if (expected.status !== 'resolved') throw new Error('missing retained registry')
    const resolved = await repo.tx(tx => tx.resolvePropertySchema('closed-root', aliasesProp), {scope})
    expect(resolved).toMatchObject({name: aliasesProp.name, fieldId: expected.schema.fieldId})
  })

  it('allows createOrGet live hits without admitting or pinning their workspace', async () => {
    await repo.tx(async tx => {
      await expect(tx.createOrGet(newBlock('closed-root')))
        .resolves.toEqual({id: 'closed-root', inserted: false})
      await tx.create(newBlock('after-live-hit', OPEN))
    }, {scope})
  })

  it('allows idempotent writes in a closed workspace', async () => {
    await repo.tx(async tx => {
      await tx.delete('closed-deleted')
      await tx.unsetProperty('closed-root', aliasesProp)
      await tx.stampReferenceTarget('closed-root', null, false)
    }, {scope})
    expect((await repo.load('closed-root'))?.properties).toEqual({})
  })

  it('keeps deterministic occupant validation ahead of write admission', async () => {
    await expect(repo.tx(tx => tx.createOrGet(newBlock('open-occupant')), {scope}))
      .rejects.toBeInstanceOf(DeterministicIdCrossWorkspaceError)
  })

  it('covers Block.set and type tagging without bridge prechecks', async () => {
    await expect(repo.block('closed-root').set(aliasesProp, ['changed'])).rejects.toThrow(refusal)
    await expect(repo.addType('closed-root', 'page')).rejects.toThrow(refusal)
    expect((await repo.load('closed-root'))?.properties).toEqual({})
  })

  it('covers a typed child helper and the production geo helper', async () => {
    await expect(repo.tx(tx => createTypedChild(repo, tx, {
      parentId: 'closed-root', content: 'record', types: [],
      properties: [propertyValue(aliasesProp, ['record'])],
    }), {scope})).rejects.toThrow(refusal)
    await expect(createOrFindPlace(repo, CLOSED, {name: 'Test Place', lat: 1, lng: 2}))
      .rejects.toThrow(refusal)
    expect(await db.db.getAll('SELECT id FROM blocks WHERE workspace_id = ?', [CLOSED]))
      .toHaveLength(3)
  })

  it('does not gate the direct database path used by sync materialization', async () => {
    await db.db.writeTransaction(async tx => {
      await tx.execute('UPDATE blocks SET content = ? WHERE id = ?', ['arrived', 'closed-root'])
    })
    expect(await db.db.get('SELECT content FROM blocks WHERE id = ?', ['closed-root']))
      .toEqual({content: 'arrived'})
  })

  it('allows reads of closed-workspace rows in a transaction', async () => {
    const row = await repo.tx(tx => tx.get('closed-root'), {scope})
    expect(row?.workspaceId).toBe(CLOSED)
  })

  it('allows explicit background writes without making their registry available', async () => {
    await repo.tx(async tx => {
      await tx.create(newBlock('forced'))
      await tx.setProperty('forced', aliasesProp, ['forced alias'])
    }, {scope, allowUnloadedWorkspace: true})
    expect((await repo.load('forced'))?.properties[aliasesProp.name]).toEqual(['forced alias'])
    expect(repo.propertySchemaResolverFor(CLOSED).resolveField('field'))
      .toEqual({status: 'identity-unavailable', reason: 'registry-not-workspace-keyed'})
    await expect(repo.tx(tx => tx.update('forced', {content: 'blocked again'}), {scope}))
      .rejects.toThrow(refusal)
  })

  it('keeps the single-workspace invariant under the override and rolls everything back', async () => {
    await expect(repo.tx(async tx => {
      await tx.create(newBlock('forced'))
      await tx.create(newBlock('other', OPEN))
    }, {scope, allowUnloadedWorkspace: true})).rejects.toBeInstanceOf(WorkspaceMismatchError)
    expect(await repo.load('forced')).toBeNull()
  })

  it('reports the transaction workspace mismatch before checking registry admission', async () => {
    await expect(repo.tx(async tx => {
      await tx.create(newBlock('open-first', OPEN))
      await tx.create(newBlock('closed-second'))
    }, {scope})).rejects.toBeInstanceOf(WorkspaceMismatchError)
    expect(await repo.load('open-first')).toBeNull()
  })

  it('checks the transaction workspace before standalone write admission', async () => {
    await expect(repo.tx(async tx => {
      await tx.create(newBlock('open-first', OPEN))
      tx.assertWritableWorkspace(CLOSED)
    }, {scope})).rejects.toBeInstanceOf(WorkspaceMismatchError)
    expect(await repo.load('open-first')).toBeNull()
  })

  it('keeps read-only enforcement under the override', async () => {
    repo.setReadOnly(true)
    await expect(repo.tx(tx => tx.create(newBlock('forced')), {
      scope, allowUnloadedWorkspace: true,
    })).rejects.toThrow(/read.only/i)
    expect(await repo.load('forced')).toBeNull()
  })

  it('rejects a closed workspace even when its previous registry is retained', async () => {
    repo.setActiveWorkspaceId(CLOSED)
    await repo.whenPropertyDefinitionsReady(CLOSED)
    repo.setActiveWorkspaceId(OPEN)
    await repo.whenPropertyDefinitionsReady(OPEN)
    expect(repo.propertySchemaResolverFor(CLOSED).resolve(aliasesProp).status).toBe('resolved')
    await expect(repo.tx(tx => tx.update('closed-root', {content: 'changed'}), {scope}))
      .rejects.toThrow(refusal)
  })

  it('keeps the captured workspace writable through switches before its first write', async () => {
    await repo.tx(async tx => {
      repo.setActiveWorkspaceId(CLOSED)
      repo.setActiveWorkspaceId('ws-third')
      await tx.create(newBlock('captured', OPEN))
      await tx.setProperty('captured', aliasesProp, ['captured alias'])
    }, {scope})
    expect((await repo.load('captured'))?.properties[aliasesProp.name]).toEqual(['captured alias'])
  })

  it('does not admit the new active workspace into a transaction captured for the old one', async () => {
    await expect(repo.tx(async tx => {
      repo.setActiveWorkspaceId(CLOSED)
      await tx.update('closed-root', {content: 'changed'})
    }, {scope})).rejects.toThrow(refusal)
    expect((await repo.load('closed-root'))?.content).toBe('closed-root')
    // A fresh transaction captures the new workspace and succeeds.
    await repo.tx(tx => tx.update('closed-root', {content: 'now open'}), {scope})
    expect((await repo.load('closed-root'))?.content).toBe('now open')
  })

  it('does not turn closing the last workspace into a bootstrap bypass', async () => {
    repo.setActiveWorkspaceId(null)
    await expect(repo.tx(tx => tx.update('closed-root', {content: 'changed'}), {scope}))
      .rejects.toThrow(refusal)
  })
})
