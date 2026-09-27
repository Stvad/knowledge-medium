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
 *     rounds: the first drains uploads, the second delivers the resulting
 *     echoes, the third proves a fixpoint), `blocks` on A == `blocks` on B
 *     == the server's rows, every synced column EXCEPT the display stamp
 *     `user_updated_at`, ordered by id. That one column is not a row
 *     version and production does not converge it — see the stranded
 *     display stamp entry below for what is asserted about it instead.
 *     Also both `ps_crud` queues empty, both change queues empty, both
 *     delivery cursors at the server version.
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
 *  - a STRANDED DISPLAY STAMP: `user_updated_at` can diverge permanently
 *    on one device while every content column and the row version
 *    converge. The server merges that column with a plain COALESCE and
 *    excludes it from the content-change bump by design
 *    (20260612000000), so it carries no ordering of its own: a patch
 *    whose drift bump lands exactly on ANOTHER device's proposed
 *    `updated_at` replaces that device's display stamp at a version the
 *    device's own echo then equal-stamp-skips (I1, `reconcile.ts`). An
 *    accepted residual, recorded at
 *    `20260803000000_add_patch_base_version_drift_bump.sql:136-155`,
 *    which also says why closing it is the worse trade: it would need a
 *    version bump on metadata-only writes, and therefore a fleet-wide
 *    re-materialize. Asserted instead: the column is never NULL, which is
 *    what that trigger's `coalesce` backfill does promise. The
 *    stranded-display-stamp canary below pins the divergence's shape, so
 *    the carve-out fails loudly if production ever closes the residual or
 *    it widens past that one column.
 *  So the structural sweeps from `fuzzKernelHarness` stay OUT of this
 *  suite: both devices converging to the same (possibly cyclic/orphaned)
 *  graph IS the property here.
 *
 * FIRST FIND (fixed, no longer red): this suite's first deep run found
 * issue #381 — a content-changing patch merged onto a drifted base could
 * produce a server stamp EQUAL to the patch author's local stamp (the +1
 * bump only cleared the old server stamp, not the author's proposed
 * stamp), so the author's echo equal-stamp-skipped and that device
 * permanently missed the other device's merged-under edit. Keeping the
 * convergence property strict rather than relaxing it to green is what
 * held the bug visible until the base-version protocol fix landed (PR
 * #525). #1163 below is a second, rarer door onto the same skip that is
 * still open — a NEW red is one whose counterexample is neither.
 *
 * KNOWN ISSUE (fuzz): issue #1163 — a PRODUCT bug this suite can reach,
 * not an oracle fault. Two devices end up permanently disagreeing on
 * `content`, at zero clock skew, surviving reload. Counterexample
 * (`prngSeed: 1`, ROOT only): A splits ROOT, B splits ROOT, roundTrip, A
 * setReferences(ROOT→ROOT), B setContent(''), A setContent('!'). Replay:
 *   FUZZ_SEED=340680830
 *   FUZZ_PATH="30:4:3:3:4:3:4:6:5:7:7:8:7:8:8:13:14:14:17:17:17:17:18:19:18:20:19:19:19:19:19:20:20:20:20:20:20:20"
 * Rarer than the display stamp it hid, because it needs the two devices
 * to write DIFFERENT content on top of the same stamp coincidence: a
 * 50-minute random-seed deep run did not hit it, so the nightly may well
 * pass. It is deliberately still asserted — the ONLY thing relaxed here
 * is the display stamp (above) — so a deep run that DOES go red with this
 * shape is #1163 and not a new find.
 *
 * What it falsifies, and why the argument looked sound: the reconcile
 * gate's I1 assumption (equal nonzero stamps ⟺ same write —
 * reconcile.ts:108-121) was held unreachable here because this universe
 * mints per-device ids (`a-gen-*` / `b-gen-*`; only 'root' is shared and
 * it's created once on A), so a device's no-pending local stamp is either
 * a delivered server stamp (content matches by construction) or its own
 * acked write's stamp u with the server at s' ≥ u carrying that same
 * write. The second case is what fails: the UN-drifted path future-clamps
 * the proposal before flooring it, so the server can ack A's write at
 * s' < u, leaving A holding a version the server never issued — a stamp
 * the local monotonic bump (I3) reaches with NO clock skew at all. A
 * later drifted patch's bump can then land exactly on u while carrying
 * B's content, and A's echo is I1-skipped before it reaches disk. The
 * anti-#381 collision guard does not cover it: that clears the CURRENT
 * author's proposed stamp, not a third party's stranded one.
 *
 * undo/redo are excluded from the op set (per-workspace managers have no
 * cross-device meaning). A separate door, still only latent: every
 * reachable kernel PATCH changes at least one content column (the
 * `updatePatchChangesBlock` no-op gate, `txEngine.ts:94-109` — a
 * metadata-only `tx.update` returns before any write or upload), so the
 * server always +1-bumps past `old.updated_at` for a content-changing
 * patch. A future harness op emitting a metadata-only PATCH would open a
 * floor without a bump, distinct from both #381 and #1163.
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
  db.getAll<Record<string, unknown>>(`SELECT ${BLOCK_COLUMN_NAMES.join(', ')} FROM blocks ORDER BY id`)

/** The one synced column the convergence oracle cannot demand — see the
 *  stranded display stamp entry in the module docblock. Dropped from the
 *  COMPARISON, not from the SELECT, so {@link expectDisplayStampPopulated} can
 *  still assert what production does promise for it. */
const UNCONVERGED_COLUMN = 'user_updated_at'

const convergedColumns = (rows: ReadonlyArray<Record<string, unknown>>) =>
  rows.map(row => Object.fromEntries(
    Object.entries(row).filter(([name]) => name !== UNCONVERGED_COLUMN)))

/** The clamp trigger's `least(coalesce(NEW.user_updated_at, NEW.updated_at),
 *  server_now_ms)` (20260803000000) can move the display stamp but never unsets
 *  it, and `txEngine` stamps it on every local write.
 *
 *  DEFENCE IN DEPTH, and the only assertion left on this column once it is out
 *  of the comparison: no generated case reaches a NULL, because every upload in
 *  this universe carries the column — dropping the fake server's backfill fails
 *  nothing. It is here so an upload or `txEngine` change that stops stamping it
 *  cannot go unnoticed now that convergence no longer covers it. */
const expectDisplayStampPopulated = (
  rows: ReadonlyArray<Record<string, unknown>>,
  who: string,
): void => {
  expect(
    rows.filter(row => row[UNCONVERGED_COLUMN] == null),
    `${who}: every row carries a populated display stamp`,
  ).toEqual([])
}

interface Universe {
  server: FakeSyncServer
  devices: readonly [Device, Device]
  rejections: unknown[]
}

/** Two reset devices sharing one ROOT-seeded workspace and one fake server —
 *  the starting state of both the property and the canary below, so the two
 *  cannot drift apart on how the universe is wired. */
const setUpTwoDevices = async (): Promise<Universe> => {
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

  return { server, devices, rejections }
}

/** Upload both, deliver+drain both, ×3 — oracle 1's quiescing rounds. */
const quiesce = async ({ server, devices, rejections }: Universe): Promise<void> => {
  for (let round = 0; round < 3; round++) {
    for (const device of devices) await upload(device, server, rejections)
    for (const device of devices) await deliverAndDrain(device, server)
  }
}

const runCase = async ({ steps }: { steps: readonly Step[] }): Promise<void> => {
  const universe = await setUpTwoDevices()
  const { server, devices, rejections } = universe

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

  // No step above generates work spontaneously — materialize writes are
  // source-NULL so they never re-enter ps_crud — so `quiesce`'s three rounds
  // strictly suffice; the assertions below prove it.
  await quiesce(universe)

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
  const rowsServer = server.rows()
  expect(convergedColumns(rowsA), 'device A == device B after quiescence')
    .toEqual(convergedColumns(rowsB))
  expect(convergedColumns(rowsA), 'devices == server ground truth after quiescence')
    .toEqual(convergedColumns(rowsServer))
  expectDisplayStampPopulated(rowsA, 'device A')
  expectDisplayStampPopulated(rowsB, 'device B')
  expectDisplayStampPopulated(rowsServer, 'server')
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

/** The interleaving that strands a display stamp, from issue #1162's shrunk
 *  counterexample. Only ROOT matters: both devices split it (so both hold it at
 *  one server version), then A rewrites its references and content while B
 *  rewrites its content. */
const STRANDED_STAMP_STEPS: readonly Step[] = [
  { kind: 'op', device: 0, op: { op: 'split', id: { pool: 0, idx: 0 }, before: '', after: ' ' } },
  { kind: 'op', device: 1, op: { op: 'split', id: { pool: 0, idx: 0 }, before: '', after: ' ' } },
  { kind: 'roundTrip' },
  { kind: 'op', device: 0, op: { op: 'setReferences', id: { pool: 0, idx: 0 }, refs: [{ target: { pool: 0, idx: 0 }, aliased: false, prop: false }] } },
  { kind: 'op', device: 1, op: { op: 'setContent', id: { pool: 0, idx: 0 }, content: '' } },
  { kind: 'op', device: 0, op: { op: 'setContent', id: { pool: 0, idx: 0 }, content: '' } },
]

// Non-fuzz pin for the one column oracle 1 above cannot demand. Pinning the
// residual's SHAPE is what keeps that carve-out from being a silent hole: this
// fails if production closes the residual (A's display stamp converges), if the
// divergence widens past the display stamp (a content column or the row version
// diverges), or if the stranding stops being reachable at all.
describe('two-repo sync convergence — stranded display stamp canary (accepted residual)', () => {
  it('strands `user_updated_at` on one device while content and the row version converge', async () => {
    // Shared dbA/dbB — an abandoned deep-tier case must be done writing first
    // (docs/fuzzing.md §6).
    await guard.barrier()

    const universe = await setUpTwoDevices()
    const { server, devices, rejections } = universe
    for (const step of STRANDED_STAMP_STEPS) {
      switch (step.kind) {
        case 'op': {
          const device = devices[step.device]
          const created = await applyKernelOp(device.repo, step.op, [device.pool])
          for (const { id } of created) device.pool.push(id)
          break
        }
        case 'roundTrip':
          for (const device of devices) await upload(device, server, rejections)
          for (const device of devices) await deliverAndDrain(device, server)
          break
      }
    }
    await quiesce(universe)
    expect(rejections, 'no upload may be quarantined in this universe').toEqual([])

    const rowOf = async (device: Device) =>
      (await allBlockColumns(device.db)).find(row => row.id === ROOT)!
    const [rootA, rootB] = [await rowOf(devices[0]), await rowOf(devices[1])]
    const rootServer = server.rows().find(row => row.id === ROOT)!

    // The precondition, asserted rather than assumed: the stranding needs B's
    // drift bump to land exactly on the `updated_at` A proposed, which is the
    // version A already holds — so A's echo hits I1's equal-stamp skip. Were
    // the stamps to stop colliding, A would simply apply the echo and the
    // assertions below would fail for a reason that is not a regression.
    expect(rootA.updated_at, "A holds the server's version for ROOT (I1's equal-stamp skip applies)")
      .toBe(rootServer.updated_at)

    // Everything the sync protocol does promise still converges.
    expect(convergedColumns([rootA]), 'A == B on every converged column')
      .toEqual(convergedColumns([rootB]))
    expect(convergedColumns([rootA]), 'A == server on every converged column')
      .toEqual(convergedColumns([rootServer]))

    // And the residual itself: A kept the display stamp it authored, the server
    // took B's, and nothing will carry the correction back.
    expect(rootB[UNCONVERGED_COLUMN], "B's display stamp is the server's")
      .toBe(rootServer[UNCONVERGED_COLUMN])
    expect(rootA[UNCONVERGED_COLUMN], "A's display stamp is stranded — NOT the server's")
      .not.toBe(rootServer[UNCONVERGED_COLUMN])
  }, 30_000)
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
