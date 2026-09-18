// @vitest-environment node

/**
 * The properties-as-blocks pass over its own claim: taking it, running under
 * it, handing it back, and clearing one that a dead claimant left behind.
 *
 * Driven through the REAL claim seam and the REAL backfill rather than probes —
 * `workspaceBackfillRunner.test.ts` owns the runner's own properties, and the
 * questions here are the ones only the actual pass can ask: whether it
 * deadlocks against its own claim, and what a device that dies mid-run leaves.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  createGraphBackfillClaim,
  graphBackfillClaimBlockId,
  releaseStrandedGraphBackfillClaim,
  type GraphBackfillClaimDeps,
} from '@/data/internals/graphBackfillClaim'
import { PROPERTY_CELL_BACKFILL_ID } from '@/data/internals/propertyCellBackfill'
import { getOrCreateMigrationsPage } from '@/data/migrationsPage'
import { MIGRATION_CLAIM_TYPE, PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import {
  addBlockTypeToProperties,
  migrationClaimantProp,
  migrationClaimedAtProp,
  migrationCompletedAtProp,
  presetIdProp,
  propertyChangeScopeProp,
  propertyNameProp,
} from '@/data/properties'

const WS = 'ws-migration-claim'
const TARGET = 'target-block'

let sharedDb: TestDb

/** A claim row exactly as SYNC delivers one: raw, so no processor runs over it
 *  and no test depends on the claim seam's own write path to establish the
 *  state it is testing against. */
const seedClaim = async (
  {completed = false, claimantId = 'peer-device'}:
    {completed?: boolean; claimantId?: string} = {},
): Promise<string> => {
  const id = graphBackfillClaimBlockId(WS, PROPERTY_CELL_BACKFILL_ID)
  const properties = addBlockTypeToProperties({
    [migrationClaimantProp.name]: claimantId,
    [migrationClaimedAtProp.name]: 1,
    ...(completed ? {[migrationCompletedAtProp.name]: 2} : {}),
  }, MIGRATION_CLAIM_TYPE)
  await sharedDb.db.execute(
    `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
       properties_json, deleted, created_at, updated_at, user_updated_at,
       created_by, updated_by)
     VALUES (?, ?, NULL, 'k-claim', ?, ?, 0, 1, 1, 1, 'user-1', 'user-1')`,
    [id, WS, PROPERTY_CELL_BACKFILL_ID, JSON.stringify(properties)],
  )
  return id
}

const claimIsLive = async (): Promise<boolean> =>
  (await sharedDb.db.getOptional<{deleted: number}>(
    'SELECT deleted FROM blocks WHERE id = ?',
    [graphBackfillClaimBlockId(WS, PROPERTY_CELL_BACKFILL_ID)],
  ))?.deleted === 0

/** A Repo wired to the REAL claim seam rather than a test stand-in: the
 *  questions here are about the machinery's own claim, and a stub that writes
 *  no claim block cannot ask them. */
const makeOperatorRepo = (): Repo => {
  // Assigned by the `createTestRepo` call below, before anything the claim
  // does can read it: the seam holds a Repo the Repo has to be built with.
  // eslint-disable-next-line prefer-const -- destructuring assignment below
  let repo!: Repo
  const deps: GraphBackfillClaimDeps = {
    get db() { return repo.db },
    tx: (fn, opts) => repo.tx(fn, opts),
    claimantId: 'this-device',
    ensureHome: (workspaceId: string) => getOrCreateMigrationsPage(repo, workspaceId),
  }
  const claim = createGraphBackfillClaim(deps)
  ;({repo} = createTestRepo({
    db: sharedDb.db, user: {id: 'user-1'}, backfillCompletionClaim: claim,
  }))
  repo.setActiveWorkspaceId(WS)
  return repo
}

const seedTarget = (repo: Repo): Promise<void> =>
  repo.tx(async tx => {
    await tx.create({
      id: TARGET, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'original',
    })
  }, {scope: ChangeScope.BlockDefault, description: 'seed'})

/** A FLIPPED workspace holding one cell the real pass has to convert, so the
 *  backfill under test is `propertyCellBackfill` itself. */
const seedFlippedWorkspaceWithOneCell = async (repo: Repo): Promise<void> => {
  await sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode,
        wk_canary, properties_migration)
     VALUES (?, 'ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
    [WS],
  )
  await repo.tx(async tx => {
    await tx.create({
      id: 'field-status', workspaceId: WS, parentId: null, orderKey: 'k-field',
      content: 'status',
      properties: {
        types: [PROPERTY_SCHEMA_TYPE],
        [propertyNameProp.name]: 'status',
        [propertyChangeScopeProp.name]: ChangeScope.BlockDefault,
        [presetIdProp.name]: 'string',
      },
    })
  }, {scope: ChangeScope.BlockDefault, description: 'seed definition'})
  await vi.waitFor(() => {
    if (!repo.propertySchemas.get('status')) throw new Error('[test] status not registered yet')
  }, {timeout: 3000})
  await seedTarget(repo)
  // RAW, so the block has a cell and no value child — the shape of a row that
  // predates the flip, which is exactly what the pass exists to convert.
  await sharedDb.db.execute(
    'UPDATE blocks SET properties_json = ? WHERE id = ?',
    [JSON.stringify({status: 'pending'}), TARGET],
  )
}

const valueChildOfTarget = async (): Promise<string | undefined> =>
  (await sharedDb.db.getOptional<{id: string}>(
    `SELECT v.id FROM blocks f JOIN blocks v ON v.parent_id = f.id
     WHERE f.parent_id = ? AND f.reference_target_id = 'field-status' AND f.deleted = 0
       AND v.deleted = 0`,
    [TARGET],
  ))?.id

const claimRow = async (): Promise<Record<string, unknown> | null> => {
  const row = await sharedDb.db.getOptional<{properties_json: string; deleted: number}>(
    'SELECT properties_json, deleted FROM blocks WHERE id = ?',
    [graphBackfillClaimBlockId(WS, PROPERTY_CELL_BACKFILL_ID)],
  )
  if (!row || row.deleted === 1) return null
  return JSON.parse(row.properties_json) as Record<string, unknown>
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })

describe('the migration running under its own claim', {timeout: 30_000}, () => {
  it('takes no outer read while its own write lock is held', async () => {
    // The batch's precondition probe. A read the pool cannot serve HANGS the
    // batch rather than failing it — behind a modal that stays up for as long
    // as the claim does, which is until this batch it is waiting on returns.
    const repo = makeOperatorRepo()
    await seedFlippedWorkspaceWithOneCell(repo)
    let inWrite = false
    const realWriteTransaction = sharedDb.db.writeTransaction.bind(sharedDb.db)
    const outer = {
      get: sharedDb.db.get.bind(sharedDb.db),
      getAll: sharedDb.db.getAll.bind(sharedDb.db),
      getOptional: sharedDb.db.getOptional.bind(sharedDb.db),
    }
    const refuseWhileWriting = (name: keyof typeof outer) =>
      (async (sql: string, params?: unknown[]) => {
        if (inWrite) throw new Error(`[test] ${name} on the Repo handle under the write lock`)
        return (outer[name] as (s: string, p?: unknown[]) => Promise<unknown>)(sql, params)
      })
    sharedDb.db.writeTransaction = (async (fn: never) => {
      inWrite = true
      try { return await realWriteTransaction(fn) } finally { inWrite = false }
    }) as typeof sharedDb.db.writeTransaction
    sharedDb.db.get = refuseWhileWriting('get') as typeof sharedDb.db.get
    sharedDb.db.getAll = refuseWhileWriting('getAll') as typeof sharedDb.db.getAll
    sharedDb.db.getOptional = refuseWhileWriting('getOptional') as typeof sharedDb.db.getOptional
    try {
      expect(await repo.runWorkspaceBackfillNow(WS, PROPERTY_CELL_BACKFILL_ID))
        .toMatchObject({outcome: 'ran'})
    } finally {
      sharedDb.db.writeTransaction = realWriteTransaction
      Object.assign(sharedDb.db, outer)
    }
  })

  it('records its completion on the claim it took', async () => {
    // End to end over the real seam: the claim row, the Migrations page under
    // it, the pass's batches and the completion stamp are all writes made
    // while the claim they wrote is in flight.
    const repo = makeOperatorRepo()
    await seedFlippedWorkspaceWithOneCell(repo)

    const result = await repo.runWorkspaceBackfillNow(WS, PROPERTY_CELL_BACKFILL_ID)

    expect(result).toMatchObject({outcome: 'ran'})
    expect(await valueChildOfTarget()).toBeDefined()
    expect(await claimRow()).toMatchObject({
      [migrationCompletedAtProp.name]: expect.any(Number) as number,
    })
  })

  it('hands back the claim of a pass that FAILED', async () => {
    // Without the release, a pass that throws leaves its claim in flight — and
    // every device holds the migration dialog up over a run that is not going
    // to finish. No stub backfill: a same-id contribution does not displace the
    // kernel's real one, so the pass that runs here is `propertyCellBackfill` —
    // and it fails, because this fixture leaves the workspace un-flipped.
    const repo = makeOperatorRepo()
    await seedTarget(repo)

    expect((await repo.runWorkspaceBackfillNow(WS, PROPERTY_CELL_BACKFILL_ID)).outcome)
      .toBe('failed')

    expect(await claimRow()).toBeNull()
  })

  it('turns a second device away without mistaking a peer\'s claim for a failure', async () => {
    // A peer's claim is in flight, so this device must report `held-by-peer`.
    // It reaches that verdict through `ensureHome`, which writes.
    const repo = makeOperatorRepo()
    await seedFlippedWorkspaceWithOneCell(repo)
    await seedClaim()

    const result = await repo.runWorkspaceBackfillNow(WS, PROPERTY_CELL_BACKFILL_ID)

    expect(result.outcome).toBe('held-by-peer')
    expect(await valueChildOfTarget()).toBeUndefined()
  })
})

describe('clearing a claim nobody will release', () => {
  /** A claim left by a device that will never come back: a DIFFERENT claimant,
   *  which is what makes `releaseClaim` useless here — it decides ownership by
   *  claimant id, so the stranded case is exactly the one it declines. */
  const strand = (): Promise<string> => seedClaim({claimantId: 'a-device-that-is-gone'})

  const HELD_BY = {claimantId: 'a-device-that-is-gone', claimedAt: 1}

  const release = (
    repo: Repo, expected = HELD_BY,
  ): Promise<'released' | 'not-held' | 'changed'> =>
    releaseStrandedGraphBackfillClaim(repo, WS, PROPERTY_CELL_BACKFILL_ID, expected)

  it('clears a stranded claim', async () => {
    const repo = makeOperatorRepo()
    await seedTarget(repo)
    await strand()

    expect(await release(repo)).toBe('released')

    expect(await claimIsLive()).toBe(false)
  })

  it('leaves a COMPLETED claim alone — that is the record of the run, not a lock', async () => {
    // Deleting it would leave the graph reading as never-migrated, and it holds
    // nothing, so there is nothing for this to do.
    const repo = makeOperatorRepo()
    await seedTarget(repo)
    await seedClaim({completed: true})

    expect(await release(repo)).toBe('not-held')

    expect(await claimIsLive()).toBe(true)
  })

  it('refuses to spend the user\'s consent on a claim they were not shown', async () => {
    // The gap between "this workspace has been held for 3 hours" and the click
    // is a human pause. In it, the run they were told about can finish and a
    // fresh one can take the graph — and deleting THAT is what the warning on
    // the confirmation says not to do.
    const repo = makeOperatorRepo()
    await seedTarget(repo)
    await strand()

    expect(await release(repo, {claimantId: 'a-device-that-is-gone', claimedAt: 999}))
      .toBe('changed')

    expect(await claimIsLive()).toBe(true)
  })

  it('says so when nothing is held, rather than reporting a release', async () => {
    const repo = makeOperatorRepo()
    await seedTarget(repo)

    expect(await release(repo)).toBe('not-held')
  })
})
