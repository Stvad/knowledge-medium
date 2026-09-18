// @vitest-environment node

/**
 * The migration lock (#1057): while a once-per-graph backfill holds a
 * workspace's claim, the graph stops accepting writes.
 *
 * One rule in place of a guard per gesture, so the tests here are about the
 * RULE — which scopes it admits, what it exempts, and where in the pipeline it
 * sits — rather than about any gesture it happens to stop.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { workspaceBackfillsFacet, type WorkspaceBackfill } from '@/data/facets'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  createGraphBackfillClaim,
  graphBackfillClaimBlockId,
  releaseStrandedGraphBackfillClaim,
  type GraphBackfillClaimDeps,
  GRAPH_MIGRATION_LOCKED,
} from '@/data/internals/graphBackfillClaim'
import { PROPERTY_CELL_BACKFILL_ID } from '@/data/internals/propertyCellBackfill'
import { MIGRATION_CLAIM_TYPE } from '@/data/blockTypes'
import { getOrCreateMigrationsPage } from '@/data/migrationsPage'
import {
  addBlockTypeToProperties,
  migrationClaimantProp,
  migrationClaimedAtProp,
  migrationCompletedAtProp,
} from '@/data/properties'
import { ReadOnlyError } from '@/data/api/errors'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import {
  presetIdProp,
  propertyChangeScopeProp,
  propertyNameProp,
} from '@/data/properties'
import { vi } from 'vitest'

const WS = 'ws-migration-lock'
const OTHER_WS = 'ws-migration-lock-other'
const TARGET = 'target-block'
const OTHER_TARGET = 'target-block-other-ws'

let sharedDb: TestDb

const makeRepo = (opts: {isReadOnly?: boolean} = {}): Repo => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}, ...opts})
  repo.setActiveWorkspaceId(WS)
  return repo
}

/** A claim row exactly as SYNC delivers one: raw, so no processor runs over it
 *  and no test depends on the claim seam's own write path to establish the
 *  state it is testing against. */
const seedClaim = async (
  {completed = false, workspaceId = WS, claimantId = 'peer-device'}:
    {completed?: boolean; workspaceId?: string; claimantId?: string} = {},
): Promise<string> => {
  const id = graphBackfillClaimBlockId(workspaceId, PROPERTY_CELL_BACKFILL_ID)
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
    [id, workspaceId, PROPERTY_CELL_BACKFILL_ID, JSON.stringify(properties)],
  )
  return id
}

/** A row from some OTHER workspace sitting at the id THIS workspace derives
 *  for its claim. */
const seedForeignRowAtOurClaimId = async (): Promise<void> => {
  const properties = addBlockTypeToProperties({
    [migrationClaimantProp.name]: 'peer-device',
    [migrationClaimedAtProp.name]: 1,
  }, MIGRATION_CLAIM_TYPE)
  await sharedDb.db.execute(
    `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
       properties_json, deleted, created_at, updated_at, user_updated_at,
       created_by, updated_by)
     VALUES (?, ?, NULL, 'k-claim', ?, ?, 0, 1, 1, 1, 'user-1', 'user-1')`,
    [graphBackfillClaimBlockId(WS, PROPERTY_CELL_BACKFILL_ID), OTHER_WS,
     PROPERTY_CELL_BACKFILL_ID, JSON.stringify(properties)],
  )
}

const seedTargetIn = async (
  repo: Repo, workspaceId: string, blockId: string,
): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({
      id: blockId, workspaceId, parentId: null, orderKey: 'a0', content: 'original',
    })
  }, {scope: ChangeScope.BlockDefault, description: 'seed'})
}

const seedTarget = (repo: Repo): Promise<void> => seedTargetIn(repo, WS, TARGET)

/** Write one property on the seeded block, under whichever scope is being
 *  admitted or refused. `graphMigrationWrite` is the exemption under test. */
const writeTo = (
  repo: Repo,
  blockId: string,
  scope: ChangeScope,
  opts: {graphMigrationWrite?: boolean} = {},
): Promise<void> =>
  repo.tx(async tx => {
    const row = await tx.get(blockId)
    await tx.update(blockId, {properties: {...row!.properties, 'probe:mark': scope}})
  }, {scope, description: `probe ${scope}`, ...opts})

const write = (
  repo: Repo,
  scope: ChangeScope,
  opts: {graphMigrationWrite?: boolean} = {},
): Promise<void> => writeTo(repo, TARGET, scope, opts)

const claimIsLive = async (): Promise<boolean> =>
  (await sharedDb.db.getOptional<{deleted: number}>(
    'SELECT deleted FROM blocks WHERE id = ?',
    [graphBackfillClaimBlockId(WS, PROPERTY_CELL_BACKFILL_ID)],
  ))?.deleted === 0

const markOn = async (id = TARGET): Promise<unknown> => {
  const row = await sharedDb.db.getOptional<{properties_json: string}>(
    'SELECT properties_json FROM blocks WHERE id = ?', [id],
  )
  return (JSON.parse(row?.properties_json ?? '{}') as Record<string, unknown>)['probe:mark']
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })

describe('while a once-per-graph backfill holds this workspace\'s claim', () => {
  it('refuses an ordinary block edit, and the row keeps its value', async () => {
    const repo = makeRepo()
    await seedTarget(repo)
    await seedClaim()

    await expect(write(repo, ChangeScope.BlockDefault)).rejects.toMatchObject({
      code: GRAPH_MIGRATION_LOCKED,
    })

    expect(await markOn()).toBeUndefined()
  })

  it('tells the user why, rather than dropping the gesture in silence', async () => {
    // The whole app stops accepting edits, so a refusal nobody surfaces reads
    // as the editor being broken. `repo.tx` fans a ProcessorRejection out to
    // `onUserError`, which is why the lock raises that type and not
    // `ReadOnlyError` beside it.
    const repo = makeRepo()
    await seedTarget(repo)
    await seedClaim()
    const seen: Array<{code: string; message: string}> = []
    repo.onUserError(err => { seen.push({code: err.code, message: err.message}) })

    await expect(write(repo, ChangeScope.BlockDefault)).rejects.toThrow()

    expect(seen).toHaveLength(1)
    expect(seen[0]!.code).toBe(GRAPH_MIGRATION_LOCKED)
    expect(seen[0]!.message).toContain('Migrations')
  })

  it('keeps the app navigable: UiState and UserPrefs still write', async () => {
    const repo = makeRepo()
    await seedTarget(repo)
    await seedClaim()

    await write(repo, ChangeScope.UiState)
    expect(await markOn()).toBe(ChangeScope.UiState)

    await write(repo, ChangeScope.UserPrefs)
    expect(await markOn()).toBe(ChangeScope.UserPrefs)
  })

  it('lets the derivation the migration itself produces through (References)', async () => {
    // The pass creates hundreds of thousands of value children, and the
    // references processor re-derives from each in its own transaction, which
    // carries no exemption flag. Refusing that scope would leave exactly the
    // rows the migration wrote without their derived references.
    const repo = makeRepo()
    await seedTarget(repo)
    await seedClaim()

    await write(repo, ChangeScope.References)

    expect(await markOn()).toBe(ChangeScope.References)
  })

  it('refuses program-authored records (Automation), which read-only allows', async () => {
    // Not a document edit, so read-only lets it through — but it is a durable
    // row with a property bag, and the pass converges by re-sweeping until a
    // sweep materializes nothing. Rows written behind it are more sweeps.
    const repo = makeRepo()
    await seedTarget(repo)
    await seedClaim()

    await expect(write(repo, ChangeScope.Automation)).rejects.toMatchObject({
      code: GRAPH_MIGRATION_LOCKED,
    })

    expect(await markOn()).toBeUndefined()
  })

  it('refuses an undo REPLAY, which no same-tx refusal can reach', async () => {
    // The reason this gate is in the pipeline and not in a processor: replay
    // deliberately skips the same-tx processor pass, so a rename put back by
    // cmd-Z is invisible to anything at that level (#1052).
    const repo = makeRepo()
    await seedTarget(repo)
    await write(repo, ChangeScope.BlockDefault)
    await seedClaim()

    await expect(repo.undo()).rejects.toMatchObject({code: GRAPH_MIGRATION_LOCKED})

    expect(await markOn()).toBe(ChangeScope.BlockDefault)
  })

  it('refuses a write to the LOCKED workspace while another one is on screen', async () => {
    // `repo.tx` admits a write to a workspace that is not the active one, so a
    // lock decided from the active workspace would let every such write past —
    // the agent bridge naming a workspace, an import, a pass that captured an
    // id before the user switched away.
    const repo = makeRepo()
    await seedTargetIn(repo, OTHER_WS, OTHER_TARGET)
    await seedClaim({workspaceId: OTHER_WS})
    repo.setActiveWorkspaceId(WS)

    await expect(writeTo(repo, OTHER_TARGET, ChangeScope.BlockDefault))
      .rejects.toMatchObject({code: GRAPH_MIGRATION_LOCKED})

    expect(await markOn(OTHER_TARGET)).toBeUndefined()
  })

  it('admits a write to an UNLOCKED workspace while the open one is locked', async () => {
    // The other direction of the same rule: the lock is per workspace, and the
    // workspace on screen says nothing about the rows being written.
    const repo = makeRepo()
    await seedTargetIn(repo, OTHER_WS, OTHER_TARGET)
    await seedClaim({workspaceId: WS})

    await writeTo(repo, OTHER_TARGET, ChangeScope.BlockDefault)

    expect(await markOn(OTHER_TARGET)).toBe(ChangeScope.BlockDefault)
  })

  it('refuses the CLAIM HOLDER\'s own edits too, not only a peer\'s', async () => {
    // The exemption is for the migration's transactions, not for the device
    // running it — and that device is where someone is most likely to be
    // typing, having just started the pass and be watching it. Nothing in the
    // predicate reads the claimant, and this is what says that is deliberate.
    const repo = makeRepo()
    await seedTarget(repo)
    await seedClaim({claimantId: 'this-device'})

    await expect(write(repo, ChangeScope.BlockDefault)).rejects.toMatchObject({
      code: GRAPH_MIGRATION_LOCKED,
    })
  })

  it('lets a transaction that IS the migration through', async () => {
    const repo = makeRepo()
    await seedTarget(repo)
    await seedClaim()

    await write(repo, ChangeScope.BlockDefault, {graphMigrationWrite: true})

    expect(await markOn()).toBe(ChangeScope.BlockDefault)
  })

  it('still reports READ-ONLY first when this device may not write at all', async () => {
    // Order, not preference: a viewer is refused whether or not a pass is
    // running, and "wait for the migration" would send them back to try again.
    const repo = makeRepo({isReadOnly: true})
    const writer = makeRepo()
    await seedTarget(writer)
    await seedClaim()

    await expect(write(repo, ChangeScope.BlockDefault)).rejects.toBeInstanceOf(ReadOnlyError)
  })
})

describe('when no pass owns the graph', () => {
  it('writes normally with no claim at all', async () => {
    const repo = makeRepo()
    await seedTarget(repo)

    await write(repo, ChangeScope.BlockDefault)

    expect(await markOn()).toBe(ChangeScope.BlockDefault)
  })

  it('writes normally once the claim records a COMPLETED run', async () => {
    // A completed claim is never released — it is the graph's record that the
    // migration happened. Reading it as active would lock this graph's writes
    // for the rest of its life.
    const repo = makeRepo()
    await seedTarget(repo)
    await seedClaim({completed: true})

    await write(repo, ChangeScope.BlockDefault)

    expect(await markOn()).toBe(ChangeScope.BlockDefault)
  })

  it('ignores a row at OUR claim id that belongs to another workspace', async () => {
    // An import that keeps its ids is the realistic route to one. Reading it
    // unscoped would let a foreign block lock this workspace's writes.
    const repo = makeRepo()
    await seedTarget(repo)
    await seedForeignRowAtOurClaimId()

    await write(repo, ChangeScope.BlockDefault)

    expect(await markOn()).toBe(ChangeScope.BlockDefault)
  })
})

describe('the migration itself, running under the lock it raised', () => {
  /** A Repo wired to the REAL claim seam rather than the test stand-in: the
   *  question here is whether the machinery deadlocks against its own claim,
   *  and a stub that writes no claim block cannot ask it. */
  const makeOperatorRepo = (backfill?: WorkspaceBackfill): Repo => {
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
    if (backfill) repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [backfill])
    return repo
  }

  /** A FLIPPED workspace holding one cell the real pass has to convert, so the
   *  backfill under test is `propertyCellBackfill` itself rather than a probe
   *  standing in for it — the kernel registers the real one under this id, and
   *  a same-id contribution does not displace it. */
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

  it('runs to completion, though its own claim is what stops everyone else', async () => {
    // The deadlock this exists to rule out: the claim row, the Migrations page
    // under it, the pass's batches and the completion stamp are all
    // BlockDefault writes made while the claim they wrote is in flight.
    const repo = makeOperatorRepo()
    await seedFlippedWorkspaceWithOneCell(repo)

    const result = await repo.runWorkspaceBackfillNow(WS, PROPERTY_CELL_BACKFILL_ID)

    expect(result).toMatchObject({outcome: 'ran'})
    expect(await valueChildOfTarget()).toBeDefined()
    expect(await claimRow()).toMatchObject({
      [migrationCompletedAtProp.name]: expect.any(Number) as number,
    })
  })

  it('hands back the claim of a pass that FAILED, which is a write the lock would refuse', async () => {
    // Without the release being exempt, a pass that throws leaves the claim it
    // took in flight and the delete that would clear it refused by that claim:
    // the graph locks itself, permanently, on a failure it could recover from.
    const repo = makeOperatorRepo({
      id: PROPERTY_CELL_BACKFILL_ID,
      trigger: 'operator',
      run: async () => { throw new Error('pass exploded') },
    })
    await seedTarget(repo)

    expect((await repo.runWorkspaceBackfillNow(WS, PROPERTY_CELL_BACKFILL_ID)).outcome)
      .toBe('failed')

    expect(await claimRow()).toBeNull()
    await write(repo, ChangeScope.BlockDefault)
    expect(await markOn()).toBe(ChangeScope.BlockDefault)
  })

  it('turns a second device away without mistaking the lock for a failure', async () => {
    // A peer's claim is in flight, so this device must report `held-by-peer`.
    // It reaches that verdict through `ensureHome`, which writes — and a lock
    // refusal there would report the graph as broken rather than as busy.
    const repo = makeOperatorRepo()
    await seedFlippedWorkspaceWithOneCell(repo)
    await seedClaim()

    const result = await repo.runWorkspaceBackfillNow(WS, PROPERTY_CELL_BACKFILL_ID)

    expect(result.outcome).toBe('held-by-peer')
    expect(await valueChildOfTarget()).toBeUndefined()
  })
})

describe('the way out of the lock', () => {
  /** A claim left by a device that will never come back: a DIFFERENT claimant,
   *  which is what makes `releaseClaim` useless here — it decides ownership by
   *  claimant id, so the stranded case is exactly the one it declines. */
  const strand = (): Promise<string> => seedClaim({claimantId: 'a-device-that-is-gone'})

  const release = (repo: Repo): Promise<'released' | 'not-held'> =>
    releaseStrandedGraphBackfillClaim(repo, WS, PROPERTY_CELL_BACKFILL_ID)

  it('clears a stranded claim, though clearing it is a write the lock refuses', async () => {
    // Without the release being exempt from the lock it lifts, a claimant that
    // died leaves the graph locked with no way out from inside the app: the
    // documented recovery was to delete the claim block, and that delete is a
    // BlockDefault write like any other.
    const repo = makeRepo()
    await seedTarget(repo)
    await strand()
    await expect(write(repo, ChangeScope.BlockDefault)).rejects.toThrow()

    expect(await release(repo)).toBe('released')

    await write(repo, ChangeScope.BlockDefault)
    expect(await markOn()).toBe(ChangeScope.BlockDefault)
  })

  it('leaves a COMPLETED claim alone — that is the record of the run, not a lock', async () => {
    // Deleting it would leave the graph reading as never-migrated, and it locks
    // nothing, so there is nothing for this command to do.
    const repo = makeRepo()
    await seedTarget(repo)
    await seedClaim({completed: true})

    expect(await release(repo)).toBe('not-held')

    expect(await claimIsLive()).toBe(true)
  })

  it('says so when nothing is held, rather than reporting a release', async () => {
    const repo = makeRepo()
    await seedTarget(repo)

    expect(await release(repo)).toBe('not-held')
  })
})
