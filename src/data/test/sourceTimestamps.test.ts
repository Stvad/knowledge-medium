import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Repo } from '../repo'
import { BlockCache } from '../blockCache'
import { ChangeScope } from '../api'
import { createTestDb, resetTestDb, type TestDb } from './createTestDb'

/**
 * `sourceTimestamps` insert opt: an import/restore path can stamp
 * `created_at` (origin) + `user_updated_at` (display "last edited") from a
 * trusted external source — e.g. Roam `create-time` / `edit-time` — while the
 * row-version `updated_at` STAYS the engine's monotonic sync discriminator
 * (born at `now`, never sourced). Display/recency reads `user_updated_at`, so
 * this surfaces the real authored dates without letting a historical value
 * drive the sync gate backwards.
 */
describe('sourceTimestamps insert opt', () => {
  const USER = 'user-1'
  // A fixed "now" far in the future of any plausible Roam timestamp, so an
  // assertion that `updated_at === NOW` proves the row-version was engine-
  // stamped and NOT taken from the (much older) source values.
  const NOW = 9_000_000_000_000
  // Real Roam create-time/edit-time from the stvad export (2019 / 2020).
  const CREATE = 1_574_916_172_766
  const EDIT = 1_584_934_242_749

  let sharedDb: TestDb
  let repo: Repo

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })
  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = new Repo({
      db: sharedDb.db,
      cache: new BlockCache(),
      user: {id: USER},
      startSyncObserver: false,
      now: () => NOW,
    })
  })
  afterEach(() => { repo.stopSyncObserver() })

  it('tx.create sources created_at + user_updated_at; updated_at stays engine now', async () => {
    await repo.tx(async tx => {
      await tx.create(
        {id: 'b', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'x'},
        {sourceTimestamps: {createdAt: CREATE, userUpdatedAt: EDIT}},
      )
    }, {scope: ChangeScope.BlockDefault})

    const row = await repo.load('b')
    expect(row?.createdAt).toBe(CREATE)
    expect(row?.userUpdatedAt).toBe(EDIT)
    // Row-version is the engine's `now`, NOT the (older) sourced edit-time —
    // a 2019 row-version would regress the server-monotonic sync gate.
    expect(row?.updatedAt).toBe(NOW)
    expect(row?.createdBy).toBe(USER)
    expect(row?.updatedBy).toBe(USER)
  })

  it('tx.createOrGet insert honors sourceTimestamps', async () => {
    await repo.tx(async tx => {
      const res = await tx.createOrGet(
        {id: 'cog', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'x'},
        {sourceTimestamps: {createdAt: CREATE, userUpdatedAt: EDIT}},
      )
      expect(res.inserted).toBe(true)
    }, {scope: ChangeScope.BlockDefault})

    const row = await repo.load('cog')
    expect(row?.createdAt).toBe(CREATE)
    expect(row?.userUpdatedAt).toBe(EDIT)
    expect(row?.updatedAt).toBe(NOW)
  })

  it('a plain create (no opt) stamps every timestamp at engine now', async () => {
    await repo.tx(async tx => {
      await tx.create(
        {id: 'plain', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'x'},
      )
    }, {scope: ChangeScope.BlockDefault})

    const row = await repo.load('plain')
    expect(row?.createdAt).toBe(NOW)
    expect(row?.updatedAt).toBe(NOW)
    expect(row?.userUpdatedAt).toBe(NOW)
  })

  it('createOrGet live-hit leaves the existing row\'s timestamps untouched', async () => {
    // First insert with sourced stamps, then a re-`createOrGet` carrying
    // DIFFERENT source values must be a pure live-hit (no rewrite) — the
    // existing-row reconcile is the backfill's job, not the insert path's.
    await repo.tx(async tx => {
      await tx.createOrGet(
        {id: 'x', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'x'},
        {sourceTimestamps: {createdAt: CREATE, userUpdatedAt: EDIT}},
      )
    }, {scope: ChangeScope.BlockDefault})

    await repo.tx(async tx => {
      const res = await tx.createOrGet(
        {id: 'x', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'x'},
        {sourceTimestamps: {createdAt: 1, userUpdatedAt: 2}},
      )
      expect(res.inserted).toBe(false)
    }, {scope: ChangeScope.BlockDefault})

    const row = await repo.load('x')
    expect(row?.createdAt).toBe(CREATE)
    expect(row?.userUpdatedAt).toBe(EDIT)
  })
})
