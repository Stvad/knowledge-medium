import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Repo } from '../repo'
import { BlockCache } from '../blockCache'
import { ChangeScope, systemAuthor } from '../api'
import { createOrRestoreTargetBlock } from '../targets'
import { createTestDb, resetTestDb, type TestDb } from './createTestDb'

/**
 * Write-side provenance: `tx.create` / `tx.createOrGet` with `{systemMint:
 * true}` stamp `updated_by` (NOT `created_by`, which stays the real user) as
 * the current user's system author, and same-tx follow-up writes (the
 * `addTypeInTx` / `setProperty` shaping every deterministic-id mint does)
 * inherit that authorship instead of promoting the row back to a real user
 * edit. The first real edit in a LATER tx promotes `updated_by`. This is the
 * discriminator the reconcile gate reads.
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

  it('stamps a systemMint create: system updated_by, real-user created_by', async () => {
    // The `system:` marker is contained to updated_by (the gate's self-clearing
    // signal). created_by stays the real user — pure identity/ownership.
    await create('mint', {systemMint: true})
    const row = await repo.load('mint')
    expect(row?.updatedBy).toBe(SYS)
    expect(row?.createdBy).toBe(USER)
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

  it('promotes updated_by to the real user on the first edit in a later tx', async () => {
    await create('mint2', {systemMint: true})
    await repo.tx(async tx => {
      await tx.update('mint2', {content: 'user-edit'})
    }, {scope: ChangeScope.BlockDefault})
    const row = await repo.load('mint2')
    // updated_by self-clears on the first real edit; created_by was the real
    // user all along (the row's owner never changed).
    expect(row?.updatedBy).toBe(USER)
    expect(row?.createdBy).toBe(USER)
  })

  it('does NOT inherit system authorship on a createOrGet live-hit', async () => {
    // markSystemMint fires only on a real INSERT. A createOrGet that hits a
    // live row must not mark it, or a same-tx edit would demote a real user's
    // row to system: and let the gate yield it to the server. Guards against a
    // refactor that marks the row before the insert/live branch.
    await create('exists') // plain user-authored row
    await repo.tx(async tx => {
      const result = await tx.createOrGet(
        {id: 'exists', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'x'},
        {systemMint: true},
      )
      expect(result.inserted).toBe(false) // live hit, no insert
      await tx.update('exists', {content: 'edited'})
    }, {scope: ChangeScope.BlockDefault})
    expect((await repo.load('exists'))?.updatedBy).toBe(USER)
  })

  it('a tombstone restore stays user-authored even via the systemMint primitive', async () => {
    // createOrRestoreTargetBlock's tombstone branch restores via tx.restore,
    // which is an UPDATE — systemMint is insert-only, so a RESTORED seat is NOT
    // a system mint. This is deliberate (the restore-door is a separate, narrower
    // concern); pin it so a future "make restore inherit the mint author" change
    // — which would re-introduce shadow-on-restore — fails loudly here.
    const seat = {id: 'seat', workspaceId: 'ws', parentId: null, orderKey: 'a0', freshContent: 's', systemMint: true}
    await repo.tx(async tx => { await createOrRestoreTargetBlock(tx, seat) }, {scope: ChangeScope.BlockDefault})
    expect((await repo.load('seat'))?.updatedBy).toBe(SYS) // born a system mint

    await repo.tx(async tx => { await tx.delete('seat') }, {scope: ChangeScope.BlockDefault})
    const restored = await repo.tx(
      async tx => createOrRestoreTargetBlock(tx, seat),
      {scope: ChangeScope.BlockDefault},
    )
    expect(restored.inserted).toBe(true) // restore counts as "this tx wrote it"
    expect((await repo.load('seat'))?.updatedBy).toBe(USER) // restored ⇒ user, not system
  })
})
