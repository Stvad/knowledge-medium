// @vitest-environment node
/**
 * Two-device sync-convergence fuzzer (issue #372 Batch 3, final item) —
 * see `src/test/fuzz.ts` for the smoke/deep tier mechanics.
 *
 * Two REAL Repos over two REAL `@powersync/node` databases, connected by
 * `createFakeSyncServer` (`./fakeSyncServer.ts` — the migrations'
 * monotonic-clamp / insert-or-touch / patch-RPC semantics, cited there).
 * Random interleaved kernel-mutator sequences run on device A and device
 * B with random sync points; after a final quiescing round-trip, both
 * devices' `blocks` tables and the server's rows must be IDENTICAL.
 *
 * The sync plumbing on each side is the REAL code, not a reimplementation:
 *  - upload: `__runUploadLoopForTest` (`src/services/powersync.ts`) — the
 *    production collect → compact (`compactBlockCrudEntries`, incl. the
 *    same-tx PUT+PATCH fusion) → `applyCompactedBlockOperations` pipeline,
 *    with the fake server plugged into the injectable `BlockUploadSink`
 *    seam and real `transaction.complete()` draining `ps_crud`.
 *  - download: the fake server writes `blocks_synced` via
 *    `BLOCKS_SYNCED_RAW_TABLE.put` (verbatim rows, exactly what PowerSync
 *    does — sync-config selects all 13 columns untransformed), firing the
 *    real change-capture queue triggers.
 *  - materialize: the test's `drain()` calls the shared
 *    `drainStagingWindowOnce` helper (`syncObserver/test/harness.ts`, also
 *    used by `materializeStateful.fuzz.test.ts`) — mirrors `drainQueueOnce`'s
 *    single-window core (`syncObserver/observer.ts:186-220` — queue read,
 *    latest-op-per-id dedup, `materializeStagingRows`, consume seqs) — and
 *    then runs the production cache/handle invalidation
 *    (`applySyncInvalidation`) exactly like the observer's `applyOutcome`
 *    (`observer.ts:167-172`) — the observer itself stays off because its
 *    `onChange`/throttle auto-drain timers are wall-clock-nondeterministic
 *    and would break fc replay/shrinking (same reasoning as
 *    `materializeStateful.fuzz.test.ts`).
 *
 * Oracles:
 *  1. CONVERGENCE — after quiescing (upload both, deliver+drain both, ×3
 *     rounds: round 1 drains uploads, round 2 delivers the resulting
 *     echoes, round 3 proves a fixpoint), `blocks` on A == `blocks` on B
 *     == the server's rows, all 13 columns, ordered by id. Also both
 *     `ps_crud` queues empty, both change queues empty, both delivery
 *     cursors at the server version.
 *  2. No illegal errors: ops may throw the usual domain rejections for
 *     incoherent combinations (`assertLegalKernelRejection`), which sync
 *     interleavings make MORE reachable (op targeting a block the other
 *     device tombstoned, merge into a synced-away subtree, ...). Anything
 *     else — including the fake server's P0002 missing-patch-target and
 *     unexpected-hard-DELETE throws, and any upload rejection recorded by
 *     `recordRejection` — is a bug.
 *
 * Deliberately NOT asserted (accepted sync-universe anomalies — the
 * consistency-audit plugin flags them for repair; they are NOT
 * convergence failures):
 *  - structural cycles: concurrent moves (A: X under Y; B: Y under X)
 *    LWW-merge per row into a parent cycle — production detects via the
 *    §4.7 cycle-scan telemetry, it does not prevent it;
 *  - live orphans: A deletes parent P while B creates a child under P.
 *  So the structural sweeps from `fuzzKernelHarness` stay OUT of this
 *  suite: both devices converging to the same (possibly cyclic/orphaned)
 *  graph IS the property here.
 *
 * KNOWN RED (deep tier): this suite's first deep run found issue #381 —
 * a content-changing patch merged onto a drifted base can produce a
 * server stamp EQUAL to the patch author's local stamp (the +1 bump only
 * clears the old server stamp, not the author's proposed stamp), so the
 * author's echo equal-stamp-skips and that device permanently misses the
 * other device's merged-under edit. The convergence property is left
 * strict per the oracle discipline; deep runs stay red on that seed
 * until the protocol fix lands. Repro in the issue.
 *
 * Known blind spot, deliberately unreachable: the reconcile gate's I1
 * assumption (equal nonzero stamps ⟺ same write — reconcile.ts:108-121)
 * breaks only for two devices minting the SAME deterministic id with
 * divergent content in the same ms. This universe mints per-device ids
 * (`a-gen-*` / `b-gen-*`; only 'root' is shared and it's created once on
 * A), so equal-stamp-divergent-content is unreachable: a device's
 * no-pending local stamp is either a delivered server stamp (content
 * matches by construction) or its own acked write's stamp u with the
 * server at s' = max(u, old+1) ≥ u carrying that same write — and any
 * LATER foreign write bumps strictly past s'. undo/redo are excluded
 * from the op set (per-workspace managers have no cross-device meaning).
 * Case (b)'s "s' ≥ u carrying that same write" step itself rests on an
 * unstated premise: every reachable kernel PATCH changes at least one
 * content column (the `updatePatchChangesBlock` no-op gate,
 * `txEngine.ts:94-109` — a metadata-only `tx.update` returns before any
 * write or upload), so the server always +1-bumps past `old.updated_at`
 * for a content-changing patch. A future harness op that emitted a
 * metadata-only PATCH (bypassing that gate) would open a SECOND
 * equal-stamp-divergent-content door — a floor without a bump — distinct
 * from issue #381.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  applyKernelOp,
  assertLegalKernelRejection,
  idSelArb,
  kernelOpArb,
  sweepDerivedIndexes,
  type KernelOpSpec,
} from '@/data/test/fuzzKernelHarness'
import { createFakeSyncServer, type FakeSyncServer } from '@/data/test/fakeSyncServer'
import {
  __applyCompactedBlockOperationsForTest,
  __runUploadLoopForTest,
} from '@/services/powersync'
import { applySyncInvalidation } from '@/data/internals/syncObserver/invalidate.js'
import { constMat, drainStagingWindowOnce, noKey } from '@/data/internals/syncObserver/test/harness.js'
import { ChangeScope } from '@/data/api'
import { BLOCK_STORAGE_COLUMNS } from '@/data/blockSchema'
import type { Repo } from '@/data/repo'
import type { BlockCache } from '@/data/blockCache'

const WS = 'ws-1'
const ROOT = 'root'

// ──── per-case device wiring ────

interface Device {
  db: TestDb['db']
  repo: Repo
  cache: BlockCache
  /** Known ids this device can target; index 0 is ROOT (pickNonRoot skips it). */
  pool: string[]
  /** Server-version delivery cursor. */
  cursor: number
}

const materializeDeps = { getMaterializability: constMat('copy'), getCek: noKey }

/** Single-window queue drain + production invalidation, via the shared
 *  `drainStagingWindowOnce` helper — see the module docblock for why this
 *  replicates `drainQueueOnce`'s core instead of starting the
 *  (timer-driven) observer. */
const drain = async (device: Device): Promise<void> => {
  const outcome = await drainStagingWindowOnce(device.db, materializeDeps)
  if (outcome === null) return
  // Production pairing (observer.ts:167-172): every materialize window is
  // followed by the LWW cache write + handle invalidation, so the repo's
  // cache/handles never go stale against the sync-applied rows.
  applySyncInvalidation(device.cache, device.repo.handleStore, outcome.snapshots, [])
}

/** Rebuild the device's target pool from its materialized `blocks` table
 *  (ROOT pinned at index 0 — `pickNonRootFromPools` convention). Includes
 *  tombstones and locally-created rows alike: incoherent targets are
 *  legal-rejection fodder, same as repoMutators. */
const refreshPool = async (device: Device): Promise<void> => {
  const rows = await device.db.getAll<{ id: string }>(
    'SELECT id FROM blocks WHERE id != ? ORDER BY id', [ROOT],
  )
  device.pool = [ROOT, ...rows.map(r => r.id)]
}

const upload = async (device: Device, server: FakeSyncServer, rejections: unknown[]): Promise<void> => {
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
}

const deliverAndDrain = async (device: Device, server: FakeSyncServer): Promise<void> => {
  device.cursor = await server.deliverTo(device.db, device.cursor)
  await drain(device)
  await refreshPool(device)
}

// ──── the property ────

type Step =
  | { kind: 'op'; device: 0 | 1; op: KernelOpSpec }
  | { kind: 'upload'; device: 0 | 1 }
  | { kind: 'deliver'; device: 0 | 1 }
  | { kind: 'roundTrip' }

const opSelArb = idSelArb({ pools: 1 })
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 6, arbitrary: fc.record({
    kind: fc.constant('op' as const),
    device: fc.constantFrom(0 as const, 1 as const),
    op: kernelOpArb(opSelArb, { exclude: ['undo', 'redo'] }),
  }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('upload' as const), device: fc.constantFrom(0 as const, 1 as const) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('deliver' as const), device: fc.constantFrom(0 as const, 1 as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('roundTrip' as const) }) },
)

const caseArb = fc.record({
  steps: fc.array(stepArb, { minLength: 1, maxLength: 30 }),
  prngSeed: fc.integer({ min: 1, max: 2 ** 31 - 2 }),
})

let dbA: TestDb
let dbB: TestDb
beforeAll(async () => {
  dbA = await createTestDb()
  dbB = await createTestDb()
})
afterAll(async () => {
  await guard.barrier()
  await dbA.cleanup()
  await dbB.cleanup()
})

/** Interrupt-barrier + Math.random pin (order-key jitter in the mutators)
 *  — `statefulFuzzGuard`, docs/fuzzing.md §6. */
const guard = statefulFuzzGuard()

// Derived from BLOCK_STORAGE_COLUMNS (not hand-duplicated) so a future 14th
// synced column is automatically compared instead of silently skipped.
const BLOCK_COLUMN_NAMES = BLOCK_STORAGE_COLUMNS.map(c => c.name)
const allBlockColumns = (db: TestDb['db']) =>
  db.getAll(`SELECT ${BLOCK_COLUMN_NAMES.join(', ')} FROM blocks ORDER BY id`)

const runCase = async ({ steps }: { steps: readonly Step[] }): Promise<void> => {
  await resetTestDb(dbA.db)
  await resetTestDb(dbB.db)

  // Server clock strictly ahead of both device clocks (1.8e12 vs 1.7e12)
  // and monotonic — the future-clamp path stays quiet so the oracle only
  // reasons about the floor+bump (see fakeSyncServer.ts on why the fake
  // requires a monotonic clock at all).
  let serverClock = 1_800_000_000_000
  const server = createFakeSyncServer({ now: () => ++serverClock })
  const rejections: unknown[] = []

  const mkDevice = (db: TestDb['db'], tag: 'a' | 'b'): Device => {
    let idCursor = 0
    const { repo, cache } = createTestRepo({
      db,
      user: { id: `user-${tag}` },
      // Distinct per-device id generators — two createTestRepo defaults
      // would mint COLLIDING gen-* ids (createTestRepo.ts caveat). The
      // shared default `now` counter (1.7e12+n per repo) is deliberate:
      // cross-device stamp coincidences on the same row are the
      // interesting LWW inputs, and the docblock argues why they can't
      // produce divergent-content equal stamps in this universe.
      newId: () => `${tag}-gen-${++idCursor}`,
    })
    repo.setActiveWorkspaceId(WS)
    return { db, repo, cache, pool: [ROOT], cursor: 0 }
  }
  const devices = [mkDevice(dbA.db, 'a'), mkDevice(dbB.db, 'b')] as const

  // Seed: ROOT is created on device A and synced everywhere before the
  // random steps — both devices then share one workspace-rooted tree.
  await devices[0].repo.tx(async tx => {
    await tx.create({ id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0' })
  }, { scope: ChangeScope.BlockDefault })
  await upload(devices[0], server, rejections)
  for (const device of devices) await deliverAndDrain(device, server)

  for (const step of steps) {
    switch (step.kind) {
      case 'op': {
        const device = devices[step.device]
        try {
          const created = await applyKernelOp(device.repo, step.op, [device.pool])
          for (const { id } of created) device.pool.push(id)
        } catch (e) {
          assertLegalKernelRejection(e, `${JSON.stringify(step.op)} on device ${step.device}`)
        }
        break
      }
      case 'upload':
        await upload(devices[step.device], server, rejections)
        break
      case 'deliver':
        await deliverAndDrain(devices[step.device], server)
        break
      case 'roundTrip':
        for (const device of devices) await upload(device, server, rejections)
        for (const device of devices) await deliverAndDrain(device, server)
        break
    }
  }

  // ── Quiesce: three full rounds (drain uploads → deliver echoes → prove
  // fixpoint). No step above generates work spontaneously — materialize
  // writes are source-NULL so they never re-enter ps_crud — so three
  // rounds strictly suffice; the assertions below prove it. ──
  for (let round = 0; round < 3; round++) {
    for (const device of devices) await upload(device, server, rejections)
    for (const device of devices) await deliverAndDrain(device, server)
  }

  expect(rejections, 'no upload may be quarantined in this universe').toEqual([])
  for (const device of devices) {
    expect(
      await device.db.getAll('SELECT id FROM ps_crud'),
      'upload queue drained at quiescence',
    ).toEqual([])
    expect(
      await device.db.getAll('SELECT seq FROM blocks_synced_changes'),
      'staging change queue drained at quiescence',
    ).toEqual([])
    expect(device.cursor, 'delivery cursor caught up to the server version').toBe(server.version())
  }

  // Sync-materialization is a different write shape than kernel txs and
  // could desync a trigger-maintained derived index (block_references/
  // block_aliases/block_types/blocks_fts) while the 13-column `blocks`
  // comparison below stays green. Reuse repoMutators' sweep (workspace-
  // agnostic recompute — see its docblock in fuzzKernelHarness.ts — so it
  // transfers unchanged to this suite's one-workspace, ROOT-pinned pool).
  for (const device of devices) await sweepDerivedIndexes(device.db)

  const [rowsA, rowsB] = [await allBlockColumns(dbA.db), await allBlockColumns(dbB.db)]
  expect(rowsA, 'device A == device B after quiescence').toEqual(rowsB)
  expect(rowsA, 'devices == server ground truth after quiescence').toEqual(server.rows())
}

describe('two-repo sync convergence (issue #372 Batch 3)', () => {
  it('interleaved mutator sequences with random sync points converge to identical state', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, ({ steps, prngSeed }) =>
        guard.run(prngSeed, () => runCase({ steps }))),
      fuzzParams(8),
    )
  }, fuzzTestTimeout())
})

// Non-fuzz pin: in the convergence universe above, per-device id generators
// (`a-gen-*` / `b-gen-*`) mean createRows never actually collides — the
// insert-or-TOUCH branch (fakeSyncServer.ts, mirroring apply_block_creates'
// ON CONFLICT DO UPDATE) is dead code there. This canary exercises it
// directly so the #244 phantom-reconcile mechanism it exists to model stays
// covered even though no generated fuzz case can reach it.
describe('fakeSyncServer — insert-or-TOUCH canary (issue #244 phantom-reconcile)', () => {
  it('createRows for an existing id preserves content, bumps the version, and re-delivers on the next deliverTo', async () => {
    let serverClock = 1_800_000_000_000
    const server = createFakeSyncServer({ now: () => ++serverClock })
    const original = {
      id: 'canary', workspace_id: WS, parent_id: null, order_key: 'a0',
      content: 'original', properties_json: '{}', references_json: '[]',
      created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000,
      user_updated_at: 1_700_000_000_000, created_by: 'user-a', updated_by: 'user-a',
      deleted: false,
    }
    await server.createRows([original])
    const versionAfterInsert = server.version()

    // A racing create for the SAME id (a different device that lost the
    // race) — the server must preserve the original row, not overwrite it.
    await server.createRows([{ ...original, content: 'racing-client-content', updated_by: 'user-b' }])
    expect(server.version(), 'insert-or-TOUCH still bumps the version (a WAL write, even though no column changed)')
      .toBeGreaterThan(versionAfterInsert)
    expect(
      server.rows().find(r => r.id === 'canary')?.content,
      'the touch discards the racing content — the server row is untouched',
    ).toBe('original')

    // Redelivery: a device whose cursor was already caught up to the
    // pre-touch version must still receive the row on the next deliverTo —
    // the WAL-write echo the #244 fix exists to produce, so the racing
    // client's local phantom gets reconciled against the authoritative row.
    const testDb = await createTestDb()
    try {
      const cursor = await server.deliverTo(testDb.db, versionAfterInsert)
      expect(cursor).toBe(server.version())
      const delivered = await testDb.db.getAll<{ id: string; content: string }>(
        'SELECT id, content FROM blocks_synced WHERE id = ?', ['canary'],
      )
      expect(delivered).toEqual([{ id: 'canary', content: 'original' }])
    } finally {
      await testDb.cleanup()
    }
  })
})
