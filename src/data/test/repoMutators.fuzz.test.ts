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
import { assertLegalKernelRejection, drain, sweepStructuralInvariants } from '@/data/test/fuzzKernelHarness'
import { ChangeScope } from '@/data/api'
import { aliasesProp, typesProp } from '@/data/properties'
import { SUBTREE_SQL } from '@/data/internals/treeQueries'
import { runConsistencyAudit } from '@/plugins/data-integrity/audit'
import type { Repo } from '@/data/repo'

const WS = 'ws-1'
const ROOT = 'root'
const WS2 = 'ws-2'
const ROOT2 = 'root2'
/** Index-aligned with the `pool` field of `IdSel` / the `pools` tuple
 *  threaded through `applyOp`. */
const WORKSPACES = [WS, WS2] as const

// ──── op descriptors ────
// Targets are indices resolved modulo the known-id list of a WORKSPACE
// POOL at execution time. `nonRoot` selectors skip that pool's seed root
// so a single early delete/merge of a root doesn't turn the whole
// sequence into error-path noise.

/** Which workspace pool an op argument resolves an id against, plus a
 *  raw index into that pool. `pool: 1` (ws-2) is deliberately rare —
 *  most sequences should stay a single coherent tree; the occasional
 *  ws-2 pick is what makes cross-workspace op combinations (and the
 *  WorkspaceMismatchError / ParentWorkspaceMismatchError rejections
 *  they provoke) reachable at all. */
type IdSel = {pool: 0 | 1; idx: number}

type Pos = {kind: 'first'} | {kind: 'last'} | {kind: 'before' | 'after'; sibling: IdSel}

type OpSpec =
  | {op: 'createChild'; parent: IdSel; pos: Pos; content: string}
  | {op: 'createSiblingAbove' | 'createSiblingBelow'; sibling: IdSel; content: string}
  | {op: 'insertChildren'; parent: IdSel; contents: string[]; pos: Pos}
  | {op: 'move'; id: IdSel; parent: IdSel; pos: Pos}
  | {op: 'setContent'; id: IdSel; content: string}
  | {op: 'indent' | 'outdent' | 'deleteBlock' | 'restoreBlock'; id: IdSel}
  | {op: 'moveVertical'; id: IdSel; direction: -1 | 1}
  | {op: 'split'; id: IdSel; before: string; after: string}
  | {op: 'merge'; into: IdSel; from: IdSel}
  | {op: 'setAlias'; id: IdSel; alias: number; clear: boolean}
  | {op: 'setType'; id: IdSel; type: number; clear: boolean}
  | {op: 'setReferences'; id: IdSel; refs: Array<{target: IdSel; aliased: boolean; prop: boolean}>}
  | {op: 'undo'} | {op: 'redo'}

// Tiny alias pool so collisions (and merge-then-undo alias handoffs —
// the block_aliases_workspace_alias_unique replay interaction) happen
// constantly rather than by generation accident.
const ALIAS_POOL = ['ax', 'ay', 'az'] as const
const TYPE_POOL = ['task', 'note'] as const

const idSelArb: fc.Arbitrary<IdSel> = fc.record({
  pool: fc.oneof({arbitrary: fc.constant(0 as const), weight: 9}, {arbitrary: fc.constant(1 as const), weight: 1}),
  idx: fc.nat(31),
})
const text = fc.string({maxLength: 8})
const posArb: fc.Arbitrary<Pos> = fc.oneof(
  {arbitrary: fc.constant({kind: 'first'} as Pos), weight: 2},
  {arbitrary: fc.constant({kind: 'last'} as Pos), weight: 3},
  {arbitrary: fc.record({kind: fc.constantFrom('before' as const, 'after' as const), sibling: idSelArb}), weight: 2},
)

const opArb: fc.Arbitrary<OpSpec> = fc.oneof(
  {weight: 5, arbitrary: fc.record({op: fc.constant('createChild' as const), parent: idSelArb, pos: posArb, content: text})},
  {weight: 2, arbitrary: fc.record({op: fc.constantFrom('createSiblingAbove' as const, 'createSiblingBelow' as const), sibling: idSelArb, content: text})},
  {weight: 1, arbitrary: fc.record({op: fc.constant('insertChildren' as const), parent: idSelArb, contents: fc.array(text, {minLength: 1, maxLength: 3}), pos: posArb})},
  {weight: 4, arbitrary: fc.record({op: fc.constant('move' as const), id: idSelArb, parent: idSelArb, pos: posArb})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('setContent' as const), id: idSelArb, content: text})},
  {weight: 3, arbitrary: fc.record({op: fc.constantFrom('indent' as const, 'outdent' as const), id: idSelArb})},
  {weight: 2, arbitrary: fc.record({op: fc.constantFrom('deleteBlock' as const, 'restoreBlock' as const), id: idSelArb})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('moveVertical' as const), id: idSelArb, direction: fc.constantFrom(-1 as const, 1 as const)})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('split' as const), id: idSelArb, before: text, after: text})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('merge' as const), into: idSelArb, from: idSelArb})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('setAlias' as const), id: idSelArb, alias: fc.nat(ALIAS_POOL.length - 1), clear: fc.boolean()})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('setType' as const), id: idSelArb, type: fc.nat(TYPE_POOL.length - 1), clear: fc.boolean()})},
  {weight: 2, arbitrary: fc.record({
    op: fc.constant('setReferences' as const),
    id: idSelArb,
    refs: fc.array(fc.record({target: idSelArb, aliased: fc.boolean(), prop: fc.boolean()}), {maxLength: 3}),
  })},
  {weight: 1, arbitrary: fc.constant({op: 'undo'} as OpSpec)},
  {weight: 1, arbitrary: fc.constant({op: 'redo'} as OpSpec)},
)

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
 *  (`[ws-1 ids, ws-2 ids]`); each pool's index 0 is that workspace's
 *  seed root. */
type IdPools = readonly [readonly string[], readonly string[]]

const pick = (sel: IdSel, pools: IdPools): string => {
  const pool = pools[sel.pool]
  return pool[sel.idx % pool.length]
}
/** Skips the pool's own seed root (index 0) so destructive ops keep
 *  that workspace's tree alive. */
const pickNonRoot = (sel: IdSel, pools: IdPools): string => {
  const pool = pools[sel.pool]
  return pool.length === 1 ? pool[0] : pool[1 + (sel.idx % (pool.length - 1))]
}

type ResolvedPos = {kind: 'first'} | {kind: 'last'} | {kind: 'before'; siblingId: string} | {kind: 'after'; siblingId: string}
const resolvePos = (pos: Pos, pools: IdPools): ResolvedPos =>
  pos.kind === 'first' || pos.kind === 'last'
    ? pos
    : pos.kind === 'before'
      ? {kind: 'before', siblingId: pick(pos.sibling, pools)}
      : {kind: 'after', siblingId: pick(pos.sibling, pools)}

/** A newly-created block, tagged with the pool (workspace) it belongs
 *  to — inferred from whichever existing id (parent/sibling/self) it
 *  was created under, since kernel mutators always inherit the parent's
 *  real `workspaceId` and that id was itself drawn from exactly one
 *  pool. */
interface Created {id: string; pool: 0 | 1}

/** Applies one op; returns any newly created blocks. */
const applyOp = async (repo: Repo, op: OpSpec, pools: IdPools): Promise<Created[]> => {
  switch (op.op) {
    case 'createChild':
      return [{id: await repo.mutate.createChild({parentId: pick(op.parent, pools), position: resolvePos(op.pos, pools), content: op.content}), pool: op.parent.pool}]
    case 'createSiblingAbove':
      return [{id: await repo.mutate.createSiblingAbove({siblingId: pickNonRoot(op.sibling, pools), content: op.content}), pool: op.sibling.pool}]
    case 'createSiblingBelow':
      return [{id: await repo.mutate.createSiblingBelow({siblingId: pickNonRoot(op.sibling, pools), content: op.content}), pool: op.sibling.pool}]
    case 'insertChildren': {
      const created = await repo.mutate.insertChildren({
        parentId: pick(op.parent, pools),
        items: op.contents.map(content => ({content})),
        position: resolvePos(op.pos, pools),
      })
      return created.map(id => ({id, pool: op.parent.pool}))
    }
    case 'move':
      await repo.mutate.move({id: pickNonRoot(op.id, pools), parentId: pick(op.parent, pools), position: resolvePos(op.pos, pools)})
      return []
    case 'setContent':
      await repo.mutate.setContent({id: pick(op.id, pools), content: op.content})
      return []
    case 'indent':
      await repo.mutate.indent({id: pickNonRoot(op.id, pools)})
      return []
    case 'outdent':
      await repo.mutate.outdent({id: pickNonRoot(op.id, pools)})
      return []
    case 'deleteBlock':
      await repo.mutate.delete({id: pickNonRoot(op.id, pools)})
      return []
    case 'restoreBlock':
      await repo.mutate.restore({id: pickNonRoot(op.id, pools)})
      return []
    case 'moveVertical':
      await repo.mutate.moveVertical({id: pickNonRoot(op.id, pools), direction: op.direction})
      return []
    case 'split':
      return [{id: await repo.mutate.split({id: pickNonRoot(op.id, pools), before: op.before, after: op.after}), pool: op.id.pool}]
    case 'merge':
      await repo.mutate.merge({intoId: pick(op.into, pools), fromId: pickNonRoot(op.from, pools)})
      return []
    case 'setAlias':
      await repo.mutate.setProperty({
        id: pick(op.id, pools),
        schema: aliasesProp,
        value: op.clear ? [] : [ALIAS_POOL[op.alias]],
      })
      return []
    case 'setType':
      await repo.mutate.setProperty({
        id: pick(op.id, pools),
        schema: typesProp,
        value: op.clear ? [] : [TYPE_POOL[op.type]],
      })
      return []
    case 'setReferences': {
      // `references` is a bookkeeping field with no kernel mutator (the
      // references plugin writes it via tx.update post-commit); writing
      // it directly exercises the block_references triggers + the
      // canonicalization path, which no other op reaches. Targets may be
      // tombstones or live in the OTHER workspace — dangling / foreign
      // targets are legal at this layer (only the full audit's
      // dangling_refs check polices them, and it does so per-workspace).
      const sourceId = pick(op.id, pools)
      const references = op.refs.map(r => {
        const targetId = pick(r.target, pools)
        return {
          id: targetId,
          alias: r.aliased ? 'ref-alias' : targetId,
          ...(r.prop ? {sourceField: 'refProp'} : {}),
        }
      })
      await repo.tx(async tx => {
        await tx.update(sourceId, {references})
      }, {scope: ChangeScope.BlockDefault})
      return []
    }
    case 'undo':
      await repo.undo()
      return []
    case 'redo':
      await repo.redo()
      return []
  }
}

// ──── invariant sweeps ────

interface RawRow {
  id: string
  parent_id: string | null
  order_key: string
  deleted: number
  workspace_id: string
}

/** Incremental-vs-recompute differential for a trigger-maintained
 *  derived index: the table's current rows must equal re-running the
 *  trigger's own SELECT over all live blocks. Reports both directions
 *  so a failure shows what's missing AND what's stale. */
const expectMirror = async (
  db: TestDb['db'], label: string, actualSql: string, expectedSql: string,
): Promise<void> => {
  const missing = await db.getAll(`${expectedSql} EXCEPT ${actualSql}`)
  const extra = await db.getAll(`${actualSql} EXCEPT ${expectedSql}`)
  expect({missing, extra}, `${label} index vs recompute`).toEqual({missing: [], extra: []})
}

const sweepDerivedIndexes = async (db: TestDb['db']): Promise<void> => {
  // block_aliases — recompute mirrors blocks_alias_insert/update
  // (clientSchema.ts): live blocks' properties_json $.alias text
  // elements, alias_lower = LOWER(alias). DISTINCT matches the
  // INSERT OR IGNORE (block_id, alias) PK dedup.
  await expectMirror(db, 'block_aliases',
    'SELECT block_id, alias, alias_lower, workspace_id FROM block_aliases',
    `SELECT DISTINCT b.id, je.value, LOWER(je.value), b.workspace_id
       FROM blocks b, json_each(b.properties_json, '$.alias') AS je
      WHERE b.deleted = 0 AND typeof(je.value) = 'text'`)

  // block_types — same shape over $.types (blocks_type_* triggers).
  await expectMirror(db, 'block_types',
    'SELECT block_id, type, workspace_id FROM block_types',
    `SELECT DISTINCT b.id, je.value, b.workspace_id
       FROM blocks b, json_each(b.properties_json, '$.types') AS je
      WHERE b.deleted = 0 AND typeof(je.value) = 'text'`)

  // block_references — recompute mirrors blocks_references_insert/update
  // (references localSchema.ts): one row per (source, target, alias,
  // sourceField-or-'') tuple of every live block's references_json.
  await expectMirror(db, 'block_references',
    'SELECT source_id, target_id, alias, source_field, workspace_id FROM block_references',
    `SELECT DISTINCT b.id, json_extract(je.value, '$.id'), json_extract(je.value, '$.alias'),
            COALESCE(json_extract(je.value, '$.sourceField'), ''), b.workspace_id
       FROM blocks b, json_each(b.references_json) AS je
      WHERE b.deleted = 0
        AND typeof(json_extract(je.value, '$.id')) = 'text'
        AND typeof(json_extract(je.value, '$.alias')) = 'text'
        AND (json_type(je.value, '$.sourceField') IS NULL
             OR typeof(json_extract(je.value, '$.sourceField')) = 'text')`)

  // blocks_fts — one row per live non-empty-content block
  // (blocks_fts_* triggers). EXCEPT is set-based, so also pin the row
  // count: a double-insert of an identical row would otherwise hide.
  await expectMirror(db, 'blocks_fts',
    'SELECT block_id, content, workspace_id FROM blocks_fts',
    `SELECT id, content, workspace_id FROM blocks WHERE deleted = 0 AND content != ''`)
  const [ftsCount, liveCount] = await Promise.all([
    db.getAll<{n: number}>('SELECT COUNT(*) AS n FROM blocks_fts'),
    db.getAll<{n: number}>(`SELECT COUNT(*) AS n FROM blocks WHERE deleted = 0 AND content != ''`),
  ])
  expect(ftsCount[0].n, 'blocks_fts row count').toBe(liveCount[0].n)

  // Every FTS row's rowid must map back to its own block_id, and the
  // rowid map (kept across soft-deletes by design) must never point at
  // a block that doesn't exist at all.
  const badJoins = await db.getAll<{block_id: string}>(
    `SELECT f.block_id FROM blocks_fts f
       LEFT JOIN blocks_fts_rowids r ON r.fts_rowid = f.rowid
      WHERE r.block_id IS NULL OR r.block_id != f.block_id`,
  )
  expect(badJoins, 'blocks_fts rowid mapping').toEqual([])
  const orphanRowids = await db.getAll<{block_id: string}>(
    `SELECT r.block_id FROM blocks_fts_rowids r
      WHERE NOT EXISTS (SELECT 1 FROM blocks b WHERE b.id = r.block_id)`,
  )
  expect(orphanRowids, 'blocks_fts_rowids orphan').toEqual([])
}

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

type CaseArgs = {ops: OpSpec[]; withUndoRedo: boolean}

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
      const created = await applyOp(repo, op, pools)
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
    ] satisfies OpSpec[]) {
      const created = await applyOp(repo, op, pools)
      for (const {id, pool} of created) pools[pool].push(id)
    }

    for (const table of ['block_aliases', 'block_types', 'block_references', 'blocks_fts']) {
      const rows = await sharedDb.db.getAll<{n: number}>(`SELECT COUNT(*) AS n FROM ${table}`)
      expect(rows[0].n, `${table} populated by the op set`).toBeGreaterThan(0)
    }
    await sweepInvariants(sharedDb.db, pools)
  })
})
