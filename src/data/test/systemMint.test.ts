import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Repo } from '../repo'
import { ChangeScope } from '../api'
import { createOrRestoreTargetBlock } from '../targets'
import { createTestDb, resetTestDb, type TestDb } from './createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'

/**
 * Write-side pristine sentinel: `tx.create` / `tx.createOrGet` with
 * `{systemMint: true}` stamp `updated_at = 0` (the sentinel the reconcile gate
 * lets yield to the server) while keeping real-user `created_by` / `updated_by`
 * and a real `user_updated_at` display stamp. Same-tx follow-up writes (the
 * shaping every deterministic-id mint does) HOLD `updated_at` at 0 rather than
 * advancing it. The first real edit in a LATER tx promotes the row-version off
 * the sentinel. (The `system:<userId>` author this used to rely on is gone —
 * the gate reads `updated_at === 0` now.)
 */
describe('systemMint pristine sentinel', () => {
  const USER = 'user-1'
  let sharedDb: TestDb
  let repo: Repo

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })
  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({db: sharedDb.db, user: {id: USER}, startSyncObserver: false}).repo
  })

  const create = (id: string, opts?: {systemMint?: boolean}) =>
    repo.tx(async tx => {
      await tx.create(
        {id, workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'x'},
        opts,
      )
    }, {scope: ChangeScope.BlockDefault})

  it('stamps a plain create with the real user and a nonzero row-version', async () => {
    await create('plain')
    const row = await repo.load('plain')
    expect(row?.updatedBy).toBe(USER)
    expect(row?.createdBy).toBe(USER)
    expect(row?.updatedAt).toBeGreaterThan(0)
  })

  it('stamps a systemMint create at the 0 sentinel, real-user authorship + display', async () => {
    // updated_at = 0 is the pristine signal; authorship + display stay real.
    await create('mint', {systemMint: true})
    const row = await repo.load('mint')
    expect(row?.updatedAt).toBe(0)
    expect(row?.updatedBy).toBe(USER)
    expect(row?.createdBy).toBe(USER)
    expect(row?.userUpdatedAt).toBeGreaterThan(0)
  })

  it('stamps a systemMint createOrGet insert at the 0 sentinel', async () => {
    await repo.tx(async tx => {
      await tx.createOrGet(
        {id: 'cog', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'x'},
        {systemMint: true},
      )
    }, {scope: ChangeScope.BlockDefault})
    expect((await repo.load('cog'))?.updatedAt).toBe(0)
  })

  it('holds updated_at at 0 across same-tx follow-up shaping writes', async () => {
    // The realistic mint shape: create the row, then shape it (set content, a
    // property) in the SAME tx. Without the hold the follow-up write would
    // advance updated_at to now() and destroy the sentinel before upload.
    await repo.tx(async tx => {
      await tx.createOrGet(
        {id: 'seat', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'seed'},
        {systemMint: true},
      )
      await tx.update('seat', {content: 'shaped'})
    }, {scope: ChangeScope.BlockDefault})
    const row = await repo.load('seat')
    expect(row?.content).toBe('shaped')
    expect(row?.updatedAt).toBe(0)
  })

  it('promotes the row-version off the sentinel on the first edit in a later tx', async () => {
    await create('mint2', {systemMint: true})
    expect((await repo.load('mint2'))?.updatedAt).toBe(0)
    await repo.tx(async tx => {
      await tx.update('mint2', {content: 'user-edit'})
    }, {scope: ChangeScope.BlockDefault})
    const row = await repo.load('mint2')
    // The first real edit advances updated_at off the 0 sentinel.
    expect(row?.updatedAt).toBeGreaterThan(0)
    expect(row?.updatedBy).toBe(USER)
    expect(row?.createdBy).toBe(USER)
  })

  it('does NOT hold a createOrGet live-hit at the sentinel', async () => {
    // markSystemMint fires only on a real INSERT. A createOrGet that hits a
    // live row must not mark it, or a same-tx edit would pin a real row's
    // version at 0 and let the gate yield it to the server. Guards against a
    // refactor that marks the row before the insert/live branch.
    await create('exists') // plain user-authored row, nonzero version
    await repo.tx(async tx => {
      const result = await tx.createOrGet(
        {id: 'exists', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'x'},
        {systemMint: true},
      )
      expect(result.inserted).toBe(false) // live hit, no insert
      await tx.update('exists', {content: 'edited'})
    }, {scope: ChangeScope.BlockDefault})
    expect((await repo.load('exists'))?.updatedAt).toBeGreaterThan(0)
  })

  it('a tombstone restore lands a real row-version, not the sentinel', async () => {
    // createOrRestoreTargetBlock's tombstone branch restores via tx.restore,
    // which is an UPDATE — systemMint is insert-only, so a RESTORED seat is NOT
    // a pristine mint. Pin it so a future "make restore inherit the mint" change
    // — which would re-introduce shadow-on-restore — fails loudly here.
    const seat = {id: 'seat', workspaceId: 'ws', parentId: null, orderKey: 'a0', freshContent: 's', systemMint: true}
    await repo.tx(async tx => { await createOrRestoreTargetBlock(tx, seat) }, {scope: ChangeScope.BlockDefault})
    expect((await repo.load('seat'))?.updatedAt).toBe(0) // born a pristine mint

    await repo.tx(async tx => { await tx.delete('seat') }, {scope: ChangeScope.BlockDefault})
    const restored = await repo.tx(
      async tx => createOrRestoreTargetBlock(tx, seat),
      {scope: ChangeScope.BlockDefault},
    )
    expect(restored.inserted).toBe(true) // restore counts as "this tx wrote it"
    expect((await repo.load('seat'))?.updatedAt).toBeGreaterThan(0) // restored ⇒ real version
  })
})
