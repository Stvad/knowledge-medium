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
import {
  createFakeSyncServer,
  MAX_TRUSTED_SKEW_MS,
  type FakeSyncServer,
} from '@/data/test/fakeSyncServer'
import {
  __applyCompactedBlockOperationsForTest,
  __compactBlockCrudEntriesForTest,
  __runUploadLoopForTest,
} from '@/services/powersync'
import { CrudEntry, UpdateType } from '@powersync/common'
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

/** Download into staging WITHOUT materializing. Splitting the two halves of
 *  `deliverAndDrain` is what lets a test place a foreign row in staging and
 *  then drain it at a chosen moment — e.g. after the local edit that raced it
 *  has already been acked. */
const deliverOnly = async (device: Device, server: FakeSyncServer): Promise<void> => {
  device.cursor = await server.deliverTo(device.db, device.cursor)
}

const drainOnly = async (device: Device): Promise<MaterializeOutcome | null> => {
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

/** Like `setup`, but the SERVER clock sits BELOW both devices and A runs an
 *  hour and a half ahead of it — past the trusted-skew cap. That makes the
 *  future-clamp live (the default `setup` deliberately keeps it quiet), which
 *  is the region the two tests at the bottom of this file are about. */
const setupFarAheadClock = async () => {
  await resetTestDb(dbA.db)
  await resetTestDb(dbB.db)
  let serverClock = 1_700_000_000_000
  const server = createFakeSyncServer({ now: () => ++serverClock })

  const mk = (db: TestDb['db'], tag: 'a' | 'b', clockStart: number): Device => {
    let time = clockStart
    let idCursor = 0
    const { repo, cache } = createTestRepo({
      db, user: { id: `user-${tag}` }, now: () => ++time,
      newId: () => `${tag}-gen-${++idCursor}`,
    })
    repo.setActiveWorkspaceId(WS)
    return { db, repo, cache, cursor: 0 }
  }
  const a = mk(dbA.db, 'a', 1_700_000_000_000 + 5_400_000)
  const b = mk(dbB.db, 'b', 1_700_000_000_000)

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

/** The contended edit both far-ahead-clock tests share: B changes content and
 *  lands first; A, which has not seen B's edit, changes a different column. */
const contendOnTarget = async (a: Device, b: Device, server: FakeSyncServer) => {
  await b.repo.tx(async tx => {
    await tx.update(TARGET, { content: 'B-content' })
  }, { scope: ChangeScope.BlockDefault })
  await upload(b, server)

  await a.repo.tx(async tx => {
    await tx.update(TARGET, { properties: { color: 'red' } })
  }, { scope: ChangeScope.BlockDefault })
  await upload(a, server)

  await quiesce([a, b], server)
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

  it('converges when the contending author\'s clock runs past the trusted-skew cap', async () => {
    // Smoke coverage for a region nothing else in JS reaches: both this file's
    // `setup` and the two-repo fuzzer pin the server clock ~1e11 ms AHEAD of
    // both devices so the future-clamp never fires. Here the server clock sits
    // BELOW the devices, so the clamp is live and A's proposal lands past the
    // cap.
    //
    // Being precise about what this does and does not prove: it does NOT pin
    // the cap or the collision guard — mutating either away leaves it green.
    // The reason is worth recording, because it is the useful finding: once the
    // clamp is live it has ALREADY pushed the server's stamp off A's local one,
    // so the equal-stamp collision #381 needs cannot form via this path at all.
    // The cap boundary is pinned by the model-level test below (and pgTAP 9);
    // this one guards against the far-ahead-clock case diverging some other way.
    const { a, b, server } = await setupFarAheadClock()
    await contendOnTarget(a, b, server)

    expect(await readRow(a, TARGET), 'the far-ahead author still learns the merged content')
      .toMatchObject({ content: 'B-content' })
    expect(await readRow(a, TARGET)).toEqual(await readRow(b, TARGET))
  })

  // The constraint any #526 fix has to satisfy, driven end to end rather than
  // through hand-built snapshots. `invalidate.test.ts` covers the unit shape,
  // but at a 6-second stamp gap — small enough that a rule keyed on stamp
  // DISTANCE sails past it while still being wrong (see #526).
  //
  // Shape: a foreign row lands in staging, A edits and gets ACKED before that
  // row is drained, so by drain time `ps_crud` is empty and the disk gate —
  // deliberately indiscriminate — writes the older foreign row over A's newer
  // local one. Disk reverts transiently and the echo converges it. The cache
  // must NOT follow disk down, or A watches its own edit vanish and come back.
  it('does not surface the transient disk revert when a foreign row drains after a local ack', async () => {
    const { a, b, server } = await setup()

    // B's edit reaches A's STAGING but is not materialized yet.
    await b.repo.tx(async tx => {
      await tx.update(TARGET, { content: 'B-content' })
    }, { scope: ChangeScope.BlockDefault })
    await upload(b, server)
    await deliverOnly(a, server)

    // A edits against its pre-B base and gets acked. `ps_crud` is now empty,
    // so the staged row from B no longer looks like it is racing a local edit.
    await a.repo.tx(async tx => {
      await tx.update(TARGET, { content: 'A-content' })
    }, { scope: ChangeScope.BlockDefault })
    await upload(a, server)

    await drainOnly(a)

    // Precondition — without this the test would pass vacuously if the staged
    // row never reached the disk gate at all. This IS the transient revert.
    expect((await readRow(a, TARGET))?.content,
      'precondition: the disk gate applied the older foreign row').toBe('B-content')

    // The claim: the UI does not follow it down.
    expect(a.cache.getSnapshot(TARGET)?.content,
      'A keeps rendering its own edit while disk is transiently reverted').toBe('A-content')

    // ...and the echo converges both, so the transient really was transient.
    await quiesce([a, b], server)
    expect(a.cache.getSnapshot(TARGET)?.content).toBe((await readRow(a, TARGET))?.content)
  })

  // Characterization, not a guarantee: this asserts a KNOWN-WRONG cache state
  // on purpose (issue #526). The test above proves DISK converges for the
  // far-ahead author; the in-memory cache does not, and this pins where that
  // line currently sits so a fix flips a named test rather than passing
  // silently.
  //
  // Why it is not fixed here: `applySyncInvalidation` writes each materialized
  // row through `cache.applyIfNewer(after, 'sync')`, whose LWW reject is
  // load-bearing — it masks the transient disk revert a rescan causes inside
  // the ack→echo window (invariant cd8f87a9). A skewed client's local stamp is
  // above anything the server can ever issue for the row, so no later delivery
  // out-stamps it and the reject becomes permanent. The two situations are
  // indistinguishable at this seam: both show "incoming stamp < cached stamp"
  // over a cache that matched disk beforehand. Separating them needs to know
  // whether OUR CLOCK is ahead of the server's, which no layer tracks today —
  // so the fix is a clock-offset estimate or a stamp clamp, not a predicate
  // here. #526 has both candidate shapes and the refutations of the two cheap
  // ones.
  it('the far-ahead author\'s cache keeps the pre-merge row even though disk converged (#526)', async () => {
    const { a, b, server } = await setupFarAheadClock()
    await contendOnTarget(a, b, server)

    const disk = await readRow(a, TARGET)
    const cached = a.cache.getSnapshot(TARGET)

    expect(disk, 'precondition: disk converged (the guarantee this PR adds)')
      .toMatchObject({ content: 'B-content' })
    expect(cached?.content, 'the gap: A renders its pre-merge content until reload')
      .toBe('original')
    // The mechanism, asserted rather than described: A's local stamp sits above
    // the capped server stamp, so every delivery for this row loses the LWW.
    expect(cached!.updatedAt).toBeGreaterThan(disk!.updated_at)
    expect(a.cache.metrics.snapshot().applyIfNewerSyncRejected).toBeGreaterThan(0)
  })

  // The exact cap-boundary collision below can't be steered through the real
  // pipeline (the proposal has to land on one specific millisecond), so it is
  // pinned against the server model directly. The end-to-end case above covers
  // the clamp-live region broadly; this covers the single value where the
  // arithmetic goes wrong.
  it('never returns a drifted patch at the author\'s own proposed stamp, even at the cap boundary', async () => {
    const SERVER_NOW = 1_700_000_000_000
    const server = createFakeSyncServer({ now: () => SERVER_NOW })

    await server.createRows([{
      id: 'x', workspace_id: WS, parent_id: null, order_key: 'a0', content: 'theirs',
      properties_json: '{}', references_json: '[]',
      created_at: SERVER_NOW - 1000, updated_at: SERVER_NOW - 1000,
      user_updated_at: SERVER_NOW - 1000, created_by: 'user-b', updated_by: 'user-b',
      deleted: false,
    }])

    // One millisecond past the cap: least() returns the cap, and `+ 1` lands
    // back exactly on the proposal — the author's own local stamp, which is
    // what the echo skip keys on.
    const proposed = SERVER_NOW + MAX_TRUSTED_SKEW_MS + 1
    await server.applyPatches([{
      id: 'x',
      payload: {
        workspace_id: WS, content: 'mine', updated_at: proposed,
        user_updated_at: proposed, updated_by: 'user-a',
        base_updated_at: SERVER_NOW - 999_999, // stale ⇒ drifted
      },
    }])

    expect(
      server.rows().find(row => row.id === 'x')?.updated_at,
      'a drifted merge must never come back at the stamp the author already holds',
    ).not.toBe(proposed)
  })

  it('a pre-upgrade patch leading a burst still forces the echo, through the real compactor', async () => {
    // The compactor's keep-first-base rule has a unit test, but that one asserts
    // a payload SHAPE. The claim that actually matters is the one in its
    // comment: inheriting a later patch's base can make a burst read as clean
    // and hand the row back at the author's own stamp — the equal-stamp skip,
    // i.e. #381 again. Nothing pinned that, so reverting the rule broke only
    // the shape assertion. This drives the real `compactBlockCrudEntries` into
    // the real server model and asserts the STAMP outcome instead.
    //
    // `ps_crud` is persistent across a bundle upgrade, so the leading patch
    // carries no base (queued by the old build) while the trailing one does.
    const V = 1_700_000_001_000
    const server = createFakeSyncServer({ now: () => 1_800_000_000_000 })
    await server.createRows([{
      id: 'x', workspace_id: WS, parent_id: null, order_key: 'a0', content: 'original',
      properties_json: '{}', references_json: '[]',
      created_at: V, updated_at: V, user_updated_at: V,
      created_by: 'user-a', updated_by: 'user-a', deleted: false,
    }])

    // Device B's concurrent edit lands first and advances the server to V+1 —
    // which is exactly the local stamp A's second edit was made against.
    await server.applyPatches([{
      id: 'x',
      payload: {workspace_id: WS, content: 'B-content', updated_at: V + 1, base_updated_at: V},
    }])
    expect(server.rows().find(r => r.id === 'x')?.updated_at).toBe(V + 1)

    // Device A's burst: edit 1 pre-upgrade (no base), edit 2 post-upgrade
    // (base = A's own local stamp from edit 1, V+1).
    const [operation] = __compactBlockCrudEntriesForTest([
      new CrudEntry(1, UpdateType.PATCH, 'blocks', 'x',
        1, {workspace_id: WS, properties_json: '{"color":"red"}', updated_at: V + 1}),
      new CrudEntry(2, UpdateType.PATCH, 'blocks', 'x',
        2, {workspace_id: WS, properties_json: '{"color":"blue"}', updated_at: V + 2,
          base_updated_at: V + 1}),
    ])
    // Narrows the compacted-operation union, and fails loudly if the burst ever
    // stops coalescing to a single patch (which would make the rest vacuous).
    if (operation?.kind !== 'patch') {
      throw new Error(`expected one compacted patch op, got ${operation?.kind}`)
    }
    await server.applyPatches([{id: 'x', payload: operation.payload}])

    // A's local row sits at V+2. If the burst shipped the inherited base it read
    // as clean, the server took A's proposal verbatim, and A's echo would come
    // back at V+2 — its own stamp — and be skipped, leaving A on 'original'.
    expect(
      server.rows().find(r => r.id === 'x')?.updated_at,
      "the echo must not return at the author's own stamp",
    ).not.toBe(V + 2)
    expect(server.rows().find(r => r.id === 'x')?.content).toBe('B-content')
  })

  it('reads a digit-string base the same way a numeric one is read, as Postgres does', async () => {
    // Oracle fidelity, not product behaviour: the real RPC reads the base with
    // `patch->>'base_updated_at'`, which returns the same text for a JSON number
    // and a JSON string of digits — verified against a live Postgres, where the
    // two forms produce byte-identical rows. The shipped client only ever emits
    // a number (`json_set` over an INTEGER column), so this is unreachable in
    // production; it matters because this fake is the convergence fuzzer's model
    // of the server, and a model that treats a string base as "absent" would
    // BUMP where production does not — masking a real #381 case rather than
    // inventing a false one.
    const SERVER_NOW = 1_700_000_000_000
    const seededVersion = SERVER_NOW - 1000

    const build = async (base: unknown) => {
      const server = createFakeSyncServer({ now: () => SERVER_NOW })
      await server.createRows([{
        id: 'x', workspace_id: WS, parent_id: null, order_key: 'a0', content: 'v0',
        properties_json: '{}', references_json: '[]',
        created_at: seededVersion, updated_at: seededVersion,
        user_updated_at: seededVersion, created_by: 'u', updated_by: 'u', deleted: false,
      }])
      await server.applyPatches([{
        id: 'x',
        payload: {
          workspace_id: WS, content: 'v1', updated_at: SERVER_NOW,
          user_updated_at: SERVER_NOW, updated_by: 'u', base_updated_at: base,
        },
      }])
      return server.rows().find(row => row.id === 'x')?.updated_at
    }

    // A base equal to the row's version means no drift, so the proposal stands.
    expect(await build(String(seededVersion))).toBe(await build(seededVersion))
    expect(await build(seededVersion)).toBe(SERVER_NOW)
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
