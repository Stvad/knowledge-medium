// @vitest-environment node
/**
 * The one thing a single-DB test cannot pin: `tryClaim`'s settle-and-re-read.
 *
 * Every other backfill test shares one local database, where the first read
 * already sees a peer's claim — so the re-read is dead code there and deleting
 * it leaves those suites green. The race it actually closes needs two
 * DATABASES converging through sync, which is what this file builds, on the
 * same wiring as `concurrentEditConvergence.test.ts`: the real upload loop →
 * a fake server → `deliverTo` → `drainStagingWindowOnce`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { createFakeSyncServer, type FakeSyncServer } from '@/data/test/fakeSyncServer'
import {
  __applyCompactedBlockOperationsForTest,
  __runUploadLoopForTest,
} from '@/services/powersync'
import { applySyncInvalidation } from '@/data/internals/syncObserver/invalidate.js'
import { constMat, drainStagingWindowOnce, noKey } from '@/data/internals/syncObserver/test/harness.js'
import { createGraphBackfillClaim, graphBackfillClaimBlockId } from '@/data/internals/graphBackfillClaim'
import { getOrCreateMigrationsPage } from '@/data/migrationsPage'
import type { Repo } from '@/data/repo'
import type { BlockCache } from '@/data/blockCache'

const WS = 'ws-claim-race'
const materializeDeps = {getMaterializability: constMat('copy'), getCek: noKey}

interface Device {
  db: TestDb['db']
  repo: Repo
  cache: BlockCache
  cursor: number
}

const upload = async (device: Device, server: FakeSyncServer): Promise<void> => {
  await __runUploadLoopForTest(
    device.db,
    {
      applyOperations: (database, ops) =>
        __applyCompactedBlockOperationsForTest(database, ops, {
          createRows: rows => server.createRows(rows),
          applyPatches: patches => server.applyPatches(patches),
          deleteRow: id => server.deleteRow(id),
        }),
      recordRejection: async () => {},
    },
    new Map(),
  )
}

const deliverAndDrain = async (device: Device, server: FakeSyncServer): Promise<void> => {
  device.cursor = await server.deliverTo(device.db, device.cursor)
  const outcome = await drainStagingWindowOnce(device.db, materializeDeps)
  if (outcome) applySyncInvalidation(device.cache, device.repo.handleStore, outcome.snapshots, [])
}

let dbA: TestDb
let dbB: TestDb
beforeAll(async () => {
  dbA = await createTestDb()
  dbB = await createTestDb()
})
afterAll(async () => {
  await dbA.cleanup()
  await dbB.cleanup()
})

describe('per-graph claim over two converging databases', () => {
  it('lets exactly one device win when both claim before either has synced', async () => {
    await resetTestDb(dbA.db)
    await resetTestDb(dbB.db)
    let serverClock = 1_800_000_000_000
    const server = createFakeSyncServer({now: () => ++serverClock})

    const mk = (db: TestDb['db'], tag: 'a' | 'b', clockStart: number): Device => {
      let time = clockStart
      let idCursor = 0
      const {repo, cache} = createTestRepo({
        db, user: {id: 'user-1'}, now: () => ++time,
        newId: () => `${tag}-gen-${++idCursor}`,
      })
      repo.setActiveWorkspaceId(WS)
      return {db, repo, cache, cursor: 0}
    }
    // A's clock leads B's, so A's claim write is unambiguously the newer of
    // the two and LWW has a clear winner to converge on.
    const a = mk(dbA.db, 'a', 1_700_000_500_000)
    const b = mk(dbB.db, 'b', 1_700_000_000_000)

    // Each device gets its own claim, with a DISTINCT claimant token — the
    // production default is per-device, and sharing one would make both read
    // their own claim as won, hiding exactly the bug this file exists for.
    const claimFor = (device: Device, claimantId: string) => createGraphBackfillClaim({
      db: device.db,
      claimantId,
      tx: (fn, opts) => device.repo.tx(fn, opts),
      // Only THIS device's own actions — push my write to the server, then
      // take back whatever the server now says. An earlier version also
      // flushed the PEER's queue, which no real device can do and which
      // handed the test the very property production lacked.
      awaitConverged: async () => {
        await upload(device, server)
        await deliverAndDrain(device, server)
        return true
      },
      ensureHome: (workspaceId) => getOrCreateMigrationsPage(device.repo, workspaceId),
    })

    const claimA = claimFor(a, 'device-a')
    const claimB = claimFor(b, 'device-b')

    // Both write their claim while neither can see the other's — the real
    // cold-start shape, two devices opening a freshly flipped workspace.
    const [wroteA, wroteB] = await Promise.all([
      claimA.tryClaim(WS, 'cell-to-children-v1'),
      claimB.tryClaim(WS, 'cell-to-children-v1'),
    ])
    // EXACTLY ONE may believe it won. Both wrote a claim and both read their
    // own back; only the post-settle re-read separates them. Delete that
    // re-read and this is [true, true].
    expect([wroteA, wroteB].filter(Boolean)).toHaveLength(1)

    // Let the echoes finish so both databases are quiescent before asserting
    // on the converged row.
    for (let round = 0; round < 3; round++) {
      for (const d of [a, b]) await upload(d, server)
      for (const d of [a, b]) await deliverAndDrain(d, server)
    }

    // After convergence both databases agree on ONE owner...
    const claimId = graphBackfillClaimBlockId(WS, 'cell-to-children-v1')
    const ownerOn = async (device: Device): Promise<string> => {
      const row = await device.db.get<{properties_json: string}>(
        'SELECT properties_json FROM blocks WHERE id = ?', [claimId],
      )
      return (JSON.parse(row.properties_json) as Record<string, string>)['migration:claimant']
    }
    const [ownerA, ownerB] = await Promise.all([ownerOn(a), ownerOn(b)])
    expect(ownerA).toBe(ownerB)

    // ...and the loser stays a loser on every later open.
    const [reA, reB] = await Promise.all([
      claimA.tryClaim(WS, 'cell-to-children-v1'),
      claimB.tryClaim(WS, 'cell-to-children-v1'),
    ])
    expect([reA, reB].filter(Boolean)).toHaveLength(1)
  }, 20_000)

  it('converges under equal clocks, where a nonzero-stamp mint would strand', async () => {
    // The case that made the earlier version of this file record
    // non-convergence as a law: with indistinguishable stamps neither device
    // adopted the other's row, so each kept reading its own claim as won.
    // That was a missing `systemMint`, not a limit of the mechanism —
    // `syncObserver/reconcile.ts` names equal NONZERO stamps on one
    // deterministic id as the shape invariant I1 misreads. Stamp 0 yields via
    // I2 instead, so both devices adopt the server's answer.
    await resetTestDb(dbA.db)
    await resetTestDb(dbB.db)
    let serverClock = 1_800_000_000_000
    const server = createFakeSyncServer({now: () => ++serverClock})

    // SAME starting clock on both — no ordering to lean on.
    const mk = (db: TestDb['db'], tag: 'a' | 'b'): Device => {
      let time = 1_700_000_000_000
      let idCursor = 0
      const {repo, cache} = createTestRepo({
        db, user: {id: 'user-1'}, now: () => ++time,
        newId: () => `${tag}-gen-${++idCursor}`,
      })
      repo.setActiveWorkspaceId(WS)
      return {db, repo, cache, cursor: 0}
    }
    const a = mk(dbA.db, 'a')
    const b = mk(dbB.db, 'b')

    const claimFor = (device: Device, claimantId: string) => createGraphBackfillClaim({
      db: device.db,
      claimantId,
      tx: (fn, opts) => device.repo.tx(fn, opts),
      awaitConverged: async () => {
        await upload(device, server)
        await deliverAndDrain(device, server)
        return true
      },
      ensureHome: (workspaceId) => getOrCreateMigrationsPage(device.repo, workspaceId),
    })

    const won = await Promise.all([
      claimFor(a, 'device-a').tryClaim(WS, 'tie-v1'),
      claimFor(b, 'device-b').tryClaim(WS, 'tie-v1'),
    ])
    expect(won.filter(Boolean)).toHaveLength(1)

    for (let round = 0; round < 3; round++) {
      for (const d of [a, b]) await upload(d, server)
      for (const d of [a, b]) await deliverAndDrain(d, server)
    }

    const claimId = graphBackfillClaimBlockId(WS, 'tie-v1')
    const ownerOn = async (device: Device): Promise<string> => {
      const row = await device.db.get<{properties_json: string}>(
        'SELECT properties_json FROM blocks WHERE id = ?', [claimId],
      )
      return (JSON.parse(row.properties_json) as Record<string, string>)['migration:claimant']
    }
    expect(await ownerOn(a)).toBe(await ownerOn(b))
  }, 20_000)

  it('re-converges a claim it already holds instead of trusting the remembered row', async () => {
    // A first attempt that wrote its claim and then TIMED OUT converging
    // leaves that row in the local DB naming us. `claimantId` is stable for
    // the life of a Repo, so a naive second attempt reads "mine → proceed"
    // and runs the pass having never heard from the server — while a peer may
    // hold the authoritative claim behind our still-queued upload.
    await resetTestDb(dbA.db)
    await resetTestDb(dbB.db)
    let serverClock = 1_800_000_000_000
    const server = createFakeSyncServer({now: () => ++serverClock})

    const mk = (db: TestDb['db'], tag: 'a' | 'b', clockStart: number): Device => {
      let time = clockStart
      let idCursor = 0
      const {repo, cache} = createTestRepo({
        db, user: {id: 'user-1'}, now: () => ++time,
        newId: () => `${tag}-gen-${++idCursor}`,
      })
      repo.setActiveWorkspaceId(WS)
      return {db, repo, cache, cursor: 0}
    }
    const a = mk(dbA.db, 'a', 1_700_000_000_000)
    const b = mk(dbB.db, 'b', 1_700_000_500_000)

    const claimFor = (device: Device, claimantId: string, converged: () => boolean) =>
      createGraphBackfillClaim({
        db: device.db,
        claimantId,
        tx: (fn, opts) => device.repo.tx(fn, opts),
        awaitConverged: async () => {
          if (!converged()) return false
          await upload(device, server)
          await deliverAndDrain(device, server)
          return true
        },
        ensureHome: (workspaceId) => getOrCreateMigrationsPage(device.repo, workspaceId),
      })

    // A claims, but its convergence times out — the row is written locally.
    let aConverges = false
    const claimA = claimFor(a, 'device-a', () => aConverges)
    expect(await claimA.tryClaim(WS, 'retry-v1')).toBe(false)


    // Meanwhile B claims for real and wins the server.
    const claimB = claimFor(b, 'device-b', () => true)
    expect(await claimB.tryClaim(WS, 'retry-v1')).toBe(true)

    // A retries. Its LOCAL row still says "device-a"; only converging can
    // tell it otherwise.
    aConverges = true
    expect(await claimA.tryClaim(WS, 'retry-v1')).toBe(false)
  }, 20_000)
})
