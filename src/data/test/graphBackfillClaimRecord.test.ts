// @vitest-environment node
/**
 * What the completion record buys, across two real databases.
 *
 * The claim does NOT arbitrate — exactly-once comes from the pass being
 * operator-triggered on one device (see `graphBackfillClaim.ts`). What it
 * still has to do is CARRY: a pass completed on one device must be visible
 * as complete on another, so a second operator is told the work is done
 * rather than repeating it. That crosses sync, so it needs two databases —
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
import { createGraphBackfillClaim } from '@/data/internals/graphBackfillClaim'
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

describe('the completion record across two databases', () => {
  const setup = async () => {
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
    return {
      server,
      a: mk(dbA.db, 'a', 1_700_000_000_000),
      b: mk(dbB.db, 'b', 1_700_000_500_000),
    }
  }

  const claimFor = (device: Device, claimantId: string) => createGraphBackfillClaim({
    db: device.db,
    claimantId,
    tx: (fn, opts) => device.repo.tx(fn, opts),
    ensureHome: (workspaceId) => getOrCreateMigrationsPage(device.repo, workspaceId),
  })

  const sync = async (devices: readonly Device[], server: FakeSyncServer) => {
    for (let round = 0; round < 3; round++) {
      for (const d of devices) await upload(d, server)
      for (const d of devices) await deliverAndDrain(d, server)
    }
  }

  it('tells a second device the pass is already done', async () => {
    const {a, b, server} = await setup()

    expect(await claimFor(a, 'device-a').tryClaim(WS, 'done-v1')).toBe('minted')
    await claimFor(a, 'device-a').markComplete(WS, 'done-v1')
    await sync([a, b], server)

    // B is a different client entirely — it must read A's completion, not
    // its own absence of one.
    expect(await claimFor(b, 'device-b').tryClaim(WS, 'done-v1')).toBe('declined')
  }, 20_000)

  it('leaves a released claim reclaimable on the other device', async () => {
    const {a, b, server} = await setup()

    expect(await claimFor(a, 'device-a').tryClaim(WS, 'rel-v1')).toBe('minted')
    // A aborts and hands the claim back.
    await claimFor(a, 'device-a').releaseClaim(WS, 'rel-v1')
    await sync([a, b], server)

    // The work still needs doing, so B must be able to take it — a released
    // claim that read as held would strand the migration for the graph.
    expect(await claimFor(b, 'device-b').tryClaim(WS, 'rel-v1')).toBe('minted')
  }, 20_000)
})
