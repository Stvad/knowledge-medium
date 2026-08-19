// @vitest-environment node
/**
 * Stateful fuzz suite for the kernel mutator surface — see
 * `src/test/fuzz.ts` for the smoke/deep tier mechanics.
 *
 * Random sequences of `repo.mutate.*` operations run against a real
 * test repo (real PowerSync/SQLite DB). Ops are data-only descriptors
 * whose targets resolve at execution time against the ids created so
 * far, so fast-check's shrinking (dropping ops from the sequence)
 * keeps the remaining ops meaningful.
 *
 * Two workspaces (`ws-1` / `ws-2`), each with its own seed root, coexist
 * in every case — op args draw ids from either pool (weighted heavily
 * toward ws-1, see `idSelArb`), including occasional deliberately
 * cross-workspace combinations (a `move` targeting a parent in the other
 * workspace, a `merge` whose `into`/`from` live in different workspaces).
 * That's what makes `WorkspaceMismatchError` (a second write in one tx
 * targeting a different workspace than the tx's first write pinned) and
 * `ParentWorkspaceMismatchError` (reparenting under a parent in a
 * different workspace) reachable — both are legal, exercised rejections
 * (see LEGAL_ERRORS). Undo/redo are per-workspace by product design
 * (issue #186), so the undo-all/redo-all oracle drains each workspace's
 * manager separately (`drainAllWorkspaces`).
 *
 * Oracles — typed domain errors are LEGAL outcomes for incoherent op
 * combinations; what must never happen silently:
 *  - a structural cycle (cycleScanSql over every known id)
 *  - a live orphan (deleted=0 block whose parent is missing/deleted)
 *  - an order-key collision among live siblings (the tie re-keying
 *    contract of the placement helpers) — an invariant of THIS universe
 *    (kernel mutators only, scoped per workspace): seed materialization
 *    (`definitionSeeds.ts`) deliberately mints sibling seeds all at
 *    `'a0'`, relying on the `(order_key, id)` tie-break to stay legal —
 *    that's a different universe and not what this sweep polices.
 *  - SUBTREE_SQL disagreeing with a plain JS pre-order walk over the
 *    raw rows, checked for BOTH workspaces' subtrees (differential test
 *    of the recursive CTE + its pinned INDEXED BY plan; also doubles as
 *    the workspace-uniformity check — a block structurally reachable
 *    from one workspace's root but tagged with the other's workspace_id
 *    shows up as a mismatch here)
 *  - a trigger-maintained derived index (block_references,
 *    block_aliases, block_types, blocks_fts) disagreeing with a
 *    from-scratch recompute over the live rows — the incremental
 *    trigger maintenance must equal re-running the trigger's own
 *    SELECT over the whole table (clientSchema.ts / references
 *    localSchema.ts)
 *  - a consistency-audit anomaly (references index mirror etc.), for
 *    either workspace
 *  - undo-all not restoring every row that existed at seed time
 *    byte-identical, INCLUDING tombstones (so undo corrupting a
 *    soft-deleted row's content/properties/parent is caught, not hidden
 *    by a `deleted = 0` filter) — or leaving a block created during the
 *    sequence live instead of tombstoned (this layer has no hard-delete,
 *    so "un-create" can only tombstone; see `expectUndoneToSeed`) — or
 *    redo-all not returning the whole tree to the post-sequence state
 *  - any non-domain error (TypeError & co. are always bugs)
 *
 * Determinism: order keys are jittered via Math.random, so each case
 * installs a seeded LCG over Math.random (restored afterwards) —
 * replays and shrink attempts see the same keys.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  applyKernelOp,
  assertLegalKernelRejection,
  drain,
  idSelArb,
  kernelOpArb,
  sweepDerivedIndexes,
  sweepStructuralInvariants,
  type KernelOpSpec,
} from '@/data/test/fuzzKernelHarness'
import { ChangeScope } from '@/data/api'
import { SUBTREE_SQL } from '@/data/internals/treeQueries'
import { runConsistencyAudit } from '@/plugins/data-integrity/audit'
import type { Repo } from '@/data/repo'

const WS = 'ws-1'
const ROOT = 'root'
const WS2 = 'ws-2'
const ROOT2 = 'root2'
/** Index-aligned with the `pool` field of `IdSel` / the `pools` array
 *  threaded through `applyKernelOp`. */
const WORKSPACES = [WS, WS2] as const

// ──── op descriptors ────
// The op vocabulary (`IdSel`/`KernelOpSpec`/`kernelOpArb`/
// `applyKernelOp`) is shared with a future two-repo convergence fuzzer
// via `@/data/test/fuzzKernelHarness` (see its docblock for what's
// shared vs. kept local). Targets are indices resolved modulo the
// known-id list of a WORKSPACE POOL at execution time. `nonRoot`
// selectors skip that pool's seed root so a single early delete/merge of
// a root doesn't turn the whole sequence into error-path noise. `pool: 1`
// (ws-2) is deliberately rare — `idSelArb({pools: 2})`'s default weights
// ([9, 1]) keep most sequences a single coherent tree; the occasional
// ws-2 pick is what makes cross-workspace op combinations (and the
// WorkspaceMismatchError / ParentWorkspaceMismatchError rejections they
// provoke) reachable at all.

const opArb: fc.Arbitrary<KernelOpSpec> = kernelOpArb(idSelArb({pools: 2}))

const caseArb = fc.record({
  // ≤ 40 ops keeps every entry inside the undo stack (depth 100) so
  // undo-all provably reaches the seed state.
  ops: fc.array(opArb, {minLength: 1, maxLength: 40}),
  withUndoRedo: fc.boolean(),
  prngSeed: fc.integer({min: 1, max: 2 ** 31 - 2}),
})

// Domain rejections the mutator surface throws for incoherent op
// combinations — legal fuzz outcomes, checked via
// `assertLegalKernelRejection` (`@/data/test/fuzzKernelHarness`), which
// includes `ParentWorkspaceMismatchError` in its union specifically for
// this suite's two-workspace universe.
//
// WorkspaceMismatchError / ParentWorkspaceMismatchError are reachable
// now that a second workspace (ws-2) is seeded and op args occasionally
// draw ids from its pool (see `idSelArb`): a cross-workspace `move` (or
// `indent`/`outdent`/`moveVertical` reparenting attempt) throws the
// latter via `requireParentInWorkspace`; a cross-workspace `merge`
// throws the latter when `from` has live children (the child re-home
// hits the parent check first) or the former when `from` has none (the
// tx pins on `delete(from)`'s workspace, then `update(into)` mismatches)
// — see `checkWorkspace` / `requireParentInWorkspace` in
// `src/data/internals/txEngine.ts`.

// ──── execution ────

/** The known-id pools, index-aligned with `WORKSPACES` / `IdSel.pool`
 *  (`[ws-1 ids, ws-2 ids]`); each pool's index 0 is that workspace's seed
 *  root. Local 2-tuple alias for the harness's general N-pool array type
 *  (`readonly (readonly string[])[]`) — see
 *  `@/data/test/fuzzKernelHarness`, whose `applyKernelOp` (built on
 *  `pickFromPools`/`pickNonRootFromPools`/`resolvePos`) this suite now
 *  calls directly instead of hand-rolling its own two-workspace copy. */
type IdPools = readonly [readonly string[], readonly string[]]

// ──── invariant sweeps ────

interface RawRow {
  id: string
  parent_id: string | null
  order_key: string
  deleted: number
  workspace_id: string
}

/** `sweepDerivedIndexes` (block_aliases/block_types/block_references/
 *  blocks_fts vs a from-scratch recompute) now lives in
 *  `@/data/test/fuzzKernelHarness` (Batch 3) so `twoRepoConvergence` can
 *  reuse it — see its docblock there for the workspace-agnostic-recompute
 *  argument for why that's safe to share across suites with different
 *  workspace counts. */

/** SUBTREE_SQL-vs-JS-walk differential for one workspace's rooted
 *  subtree. Also the workspace-uniformity check: `live` is filtered to
 *  rows actually tagged with `workspaceId`, so a block that's
 *  structurally reachable from `root` (SUBTREE_SQL doesn't care about
 *  workspace_id, only parent_id) but tagged with the WRONG workspace_id
 *  shows up as an `extra`/`missing` mismatch here — exactly the failure
 *  mode `ParentWorkspaceMismatchError` exists to prevent from ever
 *  landing. */
const sweepSubtreeForWorkspace = async (
  db: TestDb['db'], rows: readonly RawRow[], workspaceId: string, root: string,
): Promise<void> => {
  const live = rows.filter(r => r.deleted === 0 && r.workspace_id === workspaceId)
  const children = new Map<string | null, RawRow[]>()
  for (const row of live) {
    const list = children.get(row.parent_id) ?? []
    list.push(row)
    children.set(row.parent_id, list)
  }
  for (const list of children.values()) {
    list.sort((a, b) =>
      a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.id < b.id ? -1 : 1)
  }
  const expected: Array<{id: string; depth: number}> = []
  const walk = (id: string, depth: number): void => {
    expected.push({id, depth})
    for (const child of children.get(id) ?? []) walk(child.id, depth + 1)
  }
  if (live.some(r => r.id === root)) walk(root, 0)
  const subtree = await db.getAll<{id: string; depth: number}>(SUBTREE_SQL, [root])
  expect(subtree.map(r => ({id: r.id, depth: r.depth})), `SUBTREE_SQL vs JS walk (${workspaceId})`).toEqual(expected)
}

/** Cycles/orphans/collisions come from the shared
 *  `sweepStructuralInvariants` (`@/data/test/fuzzKernelHarness`), called
 *  once per seeded workspace — scoping the collision check to one
 *  workspace at a time sidesteps the cross-workspace-root false positive
 *  the old combined `(workspace_id, parent_id, order_key)` grouping
 *  worked around, and splitting the cycle scan's `ids` by pool doesn't
 *  lose detection power (a cycle reachable from any known id is still
 *  found from whichever call includes that id — the recursive walk
 *  isn't itself workspace-scoped). The rest — the "outside the seeded
 *  workspaces" allowlist check, the SUBTREE_SQL differential, and the
 *  derived-index mirrors — stays local (see the harness's own docblock
 *  for why the allowlist check doesn't fold into the shared `ws` param). */
const sweepInvariants = async (db: TestDb['db'], pools: IdPools): Promise<void> => {
  await sweepStructuralInvariants(db, {ws: WS, ids: pools[0]})
  await sweepStructuralInvariants(db, {ws: WS2, ids: pools[1]})

  const foreign = await db.getAll<{id: string}>(
    'SELECT id FROM blocks WHERE workspace_id NOT IN (?, ?)', [WS, WS2],
  )
  expect(foreign, 'block outside the seeded workspaces').toEqual([])

  // Differential: recursive CTE vs a plain JS pre-order walk, once per
  // seeded workspace (see `sweepSubtreeForWorkspace`). The CTE orders
  // siblings by the path encoding of (order_key, hex(id)) which must
  // agree with a bytewise (order_key, id) sort.
  const rows = await db.getAll<RawRow>('SELECT id, parent_id, order_key, deleted, workspace_id FROM blocks')
  await sweepSubtreeForWorkspace(db, rows, WS, ROOT)
  await sweepSubtreeForWorkspace(db, rows, WS2, ROOT2)

  await sweepDerivedIndexes(db)
}

interface SnapRow {
  id: string
  parent_id: string | null
  order_key: string
  content: string
  properties_json: string
  references_json: string
  deleted: number
}

/** Full row state, for undo/redo round-trips. Includes tombstones
 *  (`deleted`) — an undo-all that corrupts a soft-deleted row's
 *  content/properties/parent rather than restoring it byte-identically
 *  must be caught, not hidden by a `deleted = 0` filter (replay writes
 *  tombstone rows too, so undo-all should restore them exactly). */
const fullSnapshotRows = (db: TestDb['db']): Promise<SnapRow[]> =>
  db.getAll<SnapRow>(
    `SELECT id, parent_id, order_key, content, properties_json, references_json, deleted
       FROM blocks ORDER BY id`,
  )

const fullSnapshot = async (db: TestDb['db']): Promise<string> =>
  JSON.stringify(await fullSnapshotRows(db))

/** Undo-all oracle, asymmetric by construction — NOT plain snapshot
 *  equality against the seed. This data layer has no hard-delete
 *  (`txEngine.ts`'s `applyRaw`, the "Inverse of a `create`" branch):
 *  undoing a block's creation can only tombstone it, never make the row
 *  vanish. So a block created during the sequence will still be a row
 *  after undo-all — just `deleted = 1` — even though the seed snapshot
 *  never had it at all. (Confirmed empirically: the naive
 *  `fullSnapshot(...) === seedSnap` version of this check fails on the
 *  very first case, `[{op:'createChild',...}]`, with the created block
 *  present post-undo as a tombstone — legitimate divergence, not a
 *  replay bug.)
 *
 *  What must still hold, precisely:
 *   - every row that existed at seed time is restored BYTE-IDENTICAL
 *     (this is what catches undo corrupting a tombstone's content /
 *     properties / parent — the oracle gap this suite's item 2 fix
 *     targets);
 *   - every row that did NOT exist at seed time (created during the
 *     sequence) must be tombstoned, not left live — a live leftover
 *     would mean undo-all silently failed to undo a create. */
const expectUndoneToSeed = async (db: TestDb['db'], seedRows: readonly SnapRow[]): Promise<void> => {
  const current = await fullSnapshotRows(db)
  const currentById = new Map(current.map(r => [r.id, r]))
  const seedIds = new Set(seedRows.map(r => r.id))
  for (const seed of seedRows) {
    expect(currentById.get(seed.id), `undo-all: row ${seed.id} must match its seed state`).toEqual(seed)
  }
  for (const row of current) {
    if (seedIds.has(row.id)) continue
    expect(row.deleted, `undo-all: ${row.id} was created during the sequence and has no hard-delete — must be tombstoned, not live`).toBe(1)
  }
}

/** Undo (or redo) is per-workspace by product design (issue #186):
 *  `repo.undo()`/`repo.redo()` only ever act on the ACTIVE workspace's
 *  manager. A tx pinned to ws-2 records into ws-2's own manager, so
 *  draining "all" undo/redo history means switching the active
 *  workspace and draining each manager in turn. */
const drainAllWorkspaces = async (repo: Repo, direction: 'undo' | 'redo'): Promise<void> => {
  for (const workspaceId of WORKSPACES) {
    repo.setActiveWorkspaceId(workspaceId)
    await drain(() => (direction === 'undo' ? repo.undo() : repo.redo()))
  }
}

// ──── the property ────

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await guard.barrier()
  await sharedDb.cleanup()
})

/** Interrupt-barrier + Math.random pin for the shared DB — see
 *  `statefulFuzzGuard` (`@/test/fuzz`, docs/fuzzing.md §6). */
const guard = statefulFuzzGuard()

type CaseArgs = {ops: KernelOpSpec[]; withUndoRedo: boolean}

const runCase = async ({ops, withUndoRedo}: CaseArgs): Promise<void> => {
  await resetTestDb(sharedDb.db)
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0'})
  }, {scope: ChangeScope.BlockDefault})
  // Separate tx: each tx pins to the workspace of its first write, so
  // seeding both roots in one tx would itself throw
  // WorkspaceMismatchError.
  await repo.tx(async tx => {
    await tx.create({id: ROOT2, workspaceId: WS2, parentId: null, orderKey: 'a0'})
  }, {scope: ChangeScope.BlockDefault})
  // The seed txs record their own undo entries — ONE PER WORKSPACE
  // (each tx's undo entry lands in the manager for the workspace it
  // pinned to, not the "active" one) — so both must be dropped
  // explicitly; `repo.undoManager` alone only resolves to the
  // active workspace's manager and would leave ws-2's seed entry
  // sitting in its stack, which `drainAllWorkspaces` would then
  // undo PAST the seed state (deleting ROOT2 itself).
  repo.undoManagerFor(WS).clear()
  repo.undoManagerFor(WS2).clear()

  const seedRows = await fullSnapshotRows(sharedDb.db)
  const pools: [string[], string[]] = [[ROOT], [ROOT2]]
  let ranUndoRedo = false
  for (const op of ops) {
    if ((op.op === 'undo' || op.op === 'redo') && !withUndoRedo) continue
    if (op.op === 'undo' || op.op === 'redo') ranUndoRedo = true
    try {
      const created = await applyKernelOp(repo, op, pools)
      for (const {id, pool} of created) pools[pool].push(id)
    } catch (e) {
      assertLegalKernelRejection(e, JSON.stringify(op))
    }
    await sweepInvariants(sharedDb.db, pools)
  }

  const finalSnap = await fullSnapshot(sharedDb.db)
  await drainAllWorkspaces(repo, 'undo')
  await expectUndoneToSeed(sharedDb.db, seedRows)
  await sweepInvariants(sharedDb.db, pools)

  await drainAllWorkspaces(repo, 'redo')
  if (!ranUndoRedo) {
    expect(await fullSnapshot(sharedDb.db), 'redo-all returns to final state').toBe(finalSnap)
  }
  await sweepInvariants(sharedDb.db, pools)

  const auditWs1 = await runConsistencyAudit(sharedDb.db, WS, 0)
  expect(auditWs1.anomalies, `consistency audit (${WS}): ${JSON.stringify(auditWs1.checks)}`).toBe(0)
  const auditWs2 = await runConsistencyAudit(sharedDb.db, WS2, 0)
  expect(auditWs2.anomalies, `consistency audit (${WS2}): ${JSON.stringify(auditWs2.checks)}`).toBe(0)
}

describe('kernel mutator sequences', () => {
  it('preserve structural invariants and undo/redo round-trips', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, ({ops, withUndoRedo, prngSeed}) =>
        guard.run(prngSeed, () => runCase({ops, withUndoRedo}))),
      fuzzParams(10),
    )
  }, fuzzTestTimeout())

  // Non-vacuity canary: the mirror sweeps above only bite if the op set
  // actually populates the derived indexes. The original suite shipped
  // with a references mirror that passed on permanently-empty
  // references_json — this pins each index non-empty under a crafted
  // sequence so that failure mode can't silently return.
  it('op set populates every trigger-maintained derived index', async () => {
    await guard.barrier()
    await resetTestDb(sharedDb.db)
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    repo.setActiveWorkspaceId(WS)
    await repo.tx(async tx => {
      await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})

    const pools: [string[], string[]] = [[ROOT], []]
    for (const op of [
      {op: 'createChild', parent: {pool: 0, idx: 0}, pos: {kind: 'last'}, content: 'searchable text'},
      {op: 'setAlias', id: {pool: 0, idx: 1}, alias: 0, clear: false},
      {op: 'setType', id: {pool: 0, idx: 1}, type: 0, clear: false},
      {op: 'setReferences', id: {pool: 0, idx: 1}, refs: [{target: {pool: 0, idx: 0}, aliased: true, prop: true}]},
    ] satisfies KernelOpSpec[]) {
      const created = await applyKernelOp(repo, op, pools)
      for (const {id, pool} of created) pools[pool].push(id)
    }

    for (const table of ['block_aliases', 'block_types', 'block_references', 'blocks_fts']) {
      const rows = await sharedDb.db.getAll<{n: number}>(`SELECT COUNT(*) AS n FROM ${table}`)
      expect(rows[0].n, `${table} populated by the op set`).toBeGreaterThan(0)
    }
    await sweepInvariants(sharedDb.db, pools)
  })
})
