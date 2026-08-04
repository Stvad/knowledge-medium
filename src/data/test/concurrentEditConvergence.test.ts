// @vitest-environment node
/**
 * Deterministic two-device pins for issue #381 — the base-version ("did the
 * server row drift under this edit?") protocol.
 *
 * The two-repo FUZZER (`twoRepoConvergence.fuzz.test.ts`) is what FOUND #381,
 * but it reaches these shapes only by luck: the contended interleavings depend
 * on the generated step order, and the coincident-value variant below needs two
 * devices to write the SAME value to the same column, which no generator aims
 * for. These are the hand-built cases, so a regression names itself instead of
 * showing up as a random seed months later.
 *
 * Same wiring as the fuzzer (the real code end to end, not a reimplementation):
 * `__runUploadLoopForTest` → `compactBlockCrudEntries` (incl. the base
 * keep-first rule) → `applyCompactedBlockOperations` → `createFakeSyncServer`
 * (the migrations' clamp/floor/drift-bump semantics) → `blocks_synced` →
 * `drainStagingWindowOnce` → `decideStagingRow`.
 *
 * Device A's clock runs AHEAD of device B's. That is the precondition for #381,
 * not incidental: the bug needs the second editor's proposed stamp to already
 * exceed `old_server_stamp + 1`, so the old content bump's `greatest()` returned
 * the author's own stamp unchanged and the echo looked like "my own write came
 * back". With equal clocks the old code accidentally did the right thing.
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
import { ChangeScope } from '@/data/api'
import type { MaterializeOutcome } from '@/data/internals/syncObserver/materialize.js'
import type { Repo } from '@/data/repo'
import type { BlockCache } from '@/data/blockCache'

const WS = 'ws-1'
const ROOT = 'root'
const TARGET = 'shared-block'

interface Device {
  db: TestDb['db']
  repo: Repo
  cache: BlockCache
  cursor: number
}

const materializeDeps = { getMaterializability: constMat('copy'), getCek: noKey }

const upload = async (device: Device, server: FakeSyncServer): Promise<void> => {
  const rejections: unknown[] = []
  await __runUploadLoopForTest(
    device.db,
    {
      applyOperations: (database, ops) =>
        __applyCompactedBlockOperationsForTest(database, ops, {
          createRows: rows => server.createRows(rows),
          applyPatches: patches => server.applyPatches(patches),
          deleteRow: id => server.deleteRow(id),
        }),
      recordRejection: async (_db, _tx, error) => { rejections.push(error) },
    },
    new Map(),
  )
  expect(rejections, 'no upload may be quarantined in these scenarios').toEqual([])
}

/** Deliver everything new to the device and materialize one window, returning
 *  the drain outcome so a test can assert WHY a row did or didn't land. */
const deliverAndDrain = async (
  device: Device,
  server: FakeSyncServer,
): Promise<MaterializeOutcome | null> => {
  device.cursor = await server.deliverTo(device.db, device.cursor)
  const outcome = await drainStagingWindowOnce(device.db, materializeDeps)
  if (outcome) applySyncInvalidation(device.cache, device.repo.handleStore, outcome.snapshots, [])
  return outcome
}

interface RowShape {
  content: string
  properties_json: string
  deleted: number
  updated_at: number
}

const readRow = async (device: Device, id: string): Promise<RowShape | null> =>
  device.db.getOptional<RowShape>(
    'SELECT content, properties_json, deleted, updated_at FROM blocks WHERE id = ?', [id],
  )

const serverRow = (server: FakeSyncServer, id: string) =>
  server.rows().find(row => row.id === id)

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

/** Two devices sharing one server, with TARGET already created and synced
 *  everywhere. Device A's clock leads B's by ~500s (see the module docblock). */
const setup = async () => {
  await resetTestDb(dbA.db)
  await resetTestDb(dbB.db)

  // Server clock strictly ahead of both device clocks and monotonic, so the
  // future-clamp stays quiet and these tests only exercise floor/drift.
  let serverClock = 1_800_000_000_000
  const server = createFakeSyncServer({ now: () => ++serverClock })

  const mkDevice = (db: TestDb['db'], tag: 'a' | 'b', clockStart: number): Device => {
    let time = clockStart
    let idCursor = 0
    const { repo, cache } = createTestRepo({
      db,
      user: { id: `user-${tag}` },
      now: () => ++time,
      newId: () => `${tag}-gen-${++idCursor}`,
    })
    repo.setActiveWorkspaceId(WS)
    return { db, repo, cache, cursor: 0 }
  }
  const a = mkDevice(dbA.db, 'a', 1_700_000_500_000)
  const b = mkDevice(dbB.db, 'b', 1_700_000_000_000)

  await a.repo.tx(async tx => {
    await tx.create({ id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0' })
    await tx.create({
      id: TARGET, workspaceId: WS, parentId: ROOT, orderKey: 'a1', content: 'original',
    })
  }, { scope: ChangeScope.BlockDefault })
  await upload(a, server)
  for (const device of [a, b]) await deliverAndDrain(device, server)

  return { a, b, server }
}

/** Quiesce: drain uploads, deliver the resulting echoes, prove the fixpoint. */
const quiesce = async (devices: readonly Device[], server: FakeSyncServer) => {
  for (let round = 0; round < 3; round++) {
    for (const device of devices) await upload(device, server)
    for (const device of devices) await deliverAndDrain(device, server)
  }
}

describe('concurrent edits on one row converge (issue #381)', () => {
  it('the second editor materializes the merged row instead of equal-stamp-skipping its own echo', async () => {
    const { a, b, server } = await setup()

    // B edits content and lands FIRST.
    await b.repo.tx(async tx => {
      await tx.update(TARGET, { content: 'B-content' })
    }, { scope: ChangeScope.BlockDefault })
    await upload(b, server)

    // A edits a DIFFERENT column, concurrently — it has not seen B's edit, so
    // its patch is built against the pre-B base. A's clock leads, so its
    // proposed stamp already exceeds the server's post-B stamp: this is exactly
    // the case where the old content bump handed the merged row back at A's own
    // stamp and A's echo was skipped.
    await a.repo.tx(async tx => {
      await tx.update(TARGET, { properties: { color: 'red' } })
    }, { scope: ChangeScope.BlockDefault })
    await upload(a, server)

    await quiesce([a, b], server)

    const merged = serverRow(server, TARGET)
    expect(merged, 'server merged both columns (per-column LWW)').toMatchObject({
      content: 'B-content',
      properties_json: JSON.stringify({ color: 'red' }),
    })
    // The point of the fix: A ends up holding B's content, not its own stale base.
    expect(await readRow(a, TARGET)).toMatchObject({
      content: 'B-content',
      properties_json: JSON.stringify({ color: 'red' }),
    })
    expect(await readRow(a, TARGET)).toEqual(await readRow(b, TARGET))
  })

  it('converges when both devices write the SAME value and the merge changes no content column', async () => {
    const { a, b, server } = await setup()

    // B renames the block and then deletes it — two txs, one upload, so the
    // compactor coalesces them into ONE wire PATCH carrying {content, deleted}.
    await b.repo.tx(async tx => {
      await tx.update(TARGET, { content: 'B-renamed' })
    }, { scope: ChangeScope.BlockDefault })
    await b.repo.tx(async tx => {
      await tx.delete(TARGET)
    }, { scope: ChangeScope.BlockDefault })
    await upload(b, server)

    // A concurrently deletes the same block. Its patch sets deleted=1 — a value
    // the merged server row ALREADY has, so the merge changes no content column
    // and the pre-fix content-gated bump never fired: the row came back at A's
    // own stamp and A silently kept the pre-rename content forever. Drift, not
    // content, is what makes this case visible.
    await a.repo.tx(async tx => {
      await tx.delete(TARGET)
    }, { scope: ChangeScope.BlockDefault })
    await upload(a, server)

    await quiesce([a, b], server)

    expect(serverRow(server, TARGET)).toMatchObject({ content: 'B-renamed', deleted: 1 })
    expect(await readRow(a, TARGET), "A learns B's rename that rode along with the delete")
      .toMatchObject({ content: 'B-renamed', deleted: 1 })
    expect(await readRow(a, TARGET)).toEqual(await readRow(b, TARGET))
  })

  it('leaves an UNCONTENDED echo skippable, so the fix costs one re-materialize per contended write and no more', async () => {
    // The cost floor. Making every echo re-materialize would also fix #381 —
    // and would rewrite every edited row on its author's device, fleet-wide,
    // re-firing the FTS/alias/reference triggers each time. This asserts the
    // base protocol buys the fix WITHOUT that: an edit nobody contended still
    // comes back at the author's own stamp and is skipped.
    const { a, server } = await setup()

    await a.repo.tx(async tx => {
      await tx.update(TARGET, { content: 'solo-edit' })
    }, { scope: ChangeScope.BlockDefault })
    await upload(a, server)

    const outcome = await deliverAndDrain(a, server)
    expect(outcome?.skippedStale, 'the uncontended echo is recognized as the author\'s own write')
      .toContain(TARGET)
    expect(outcome?.applied, 'and is NOT re-materialized').not.toContain(TARGET)
  })
})
