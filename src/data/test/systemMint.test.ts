import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Repo } from '../repo'
import { BlockCache } from '../blockCache'
import { ChangeScope, systemAuthor } from '../api'
import { createTestDb, resetTestDb, type TestDb } from './createTestDb'

/**
 * Write-side provenance: `tx.create` / `tx.createOrGet` with `{systemMint:
 * true}` stamp `created_by` / `updated_by` as the current user's system
 * author, and same-tx follow-up writes (the `addTypeInTx` / `setProperty`
 * shaping every deterministic-id mint does) inherit that authorship instead
 * of promoting the row back to a real user edit. The first real edit in a
 * LATER tx promotes it. This is the discriminator the reconcile gate reads.
 */
describe('systemMint authorship', () => {
  const USER = 'user-1'
  const SYS = systemAuthor(USER)
  let sharedDb: TestDb
  let repo: Repo

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })
  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = new Repo({db: sharedDb.db, cache: new BlockCache(), user: {id: USER}, startSyncObserver: false})
  })
  afterEach(() => { repo.stopSyncObserver() })

  const create = (id: string, opts?: {systemMint?: boolean}) =>
    repo.tx(async tx => {
      await tx.create(
        {id, workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'x'},
        opts,
      )
    }, {scope: ChangeScope.BlockDefault})

  it('stamps a plain create with the real user', async () => {
    await create('plain')
    const row = await repo.load('plain')
    expect(row?.updatedBy).toBe(USER)
    expect(row?.createdBy).toBe(USER)
  })

  it('stamps a systemMint create with the system author', async () => {
    await create('mint', {systemMint: true})
    const row = await repo.load('mint')
    expect(row?.updatedBy).toBe(SYS)
    expect(row?.createdBy).toBe(SYS)
  })

  it('stamps a systemMint createOrGet insert with the system author', async () => {
    await repo.tx(async tx => {
      await tx.createOrGet(
        {id: 'cog', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'x'},
        {systemMint: true},
      )
    }, {scope: ChangeScope.BlockDefault})
    const row = await repo.load('cog')
    expect(row?.updatedBy).toBe(SYS)
  })

  it('keeps same-tx follow-up writes on a system mint system-authored', async () => {
    // The realistic mint shape: create the row, then shape it (set content,
    // a property) in the SAME tx. Without inheritance the follow-up write
    // would stamp the real user and defeat the discriminator.
    await repo.tx(async tx => {
      await tx.createOrGet(
        {id: 'seat', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'seed'},
        {systemMint: true},
      )
      await tx.update('seat', {content: 'shaped'})
    }, {scope: ChangeScope.BlockDefault})
    const row = await repo.load('seat')
    expect(row?.content).toBe('shaped')
    expect(row?.updatedBy).toBe(SYS)
  })

  it('promotes to the real user on the first edit in a later tx', async () => {
    await create('mint2', {systemMint: true})
    await repo.tx(async tx => {
      await tx.update('mint2', {content: 'user-edit'})
    }, {scope: ChangeScope.BlockDefault})
    const row = await repo.load('mint2')
    expect(row?.updatedBy).toBe(USER)
    // created_by is immutable — the mint provenance is still legible there.
    expect(row?.createdBy).toBe(SYS)
  })
})
