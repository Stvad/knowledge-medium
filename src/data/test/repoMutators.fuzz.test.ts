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
 * Oracles — typed domain errors are LEGAL outcomes for incoherent op
 * combinations; what must never happen silently:
 *  - a structural cycle (cycleScanSql over every known id)
 *  - a live orphan (deleted=0 block whose parent is missing/deleted)
 *  - an order-key collision among live siblings (the tie re-keying
 *    contract of the placement helpers)
 *  - SUBTREE_SQL disagreeing with a plain JS pre-order walk over the
 *    raw rows (differential test of the recursive CTE + its pinned
 *    INDEXED BY plan)
 *  - a trigger-maintained derived index (block_references,
 *    block_aliases, block_types, blocks_fts) disagreeing with a
 *    from-scratch recompute over the live rows — the incremental
 *    trigger maintenance must equal re-running the trigger's own
 *    SELECT over the whole table (clientSchema.ts / references
 *    localSchema.ts)
 *  - a consistency-audit anomaly (references index mirror etc.)
 *  - undo-all not returning the live tree to its seed state, or
 *    redo-all not returning it to the post-sequence state
 *  - any non-domain error (TypeError & co. are always bugs)
 *
 * Determinism: order keys are jittered via Math.random, so each case
 * installs a seeded LCG over Math.random (restored afterwards) —
 * replays and shrink attempts see the same keys.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  BlockNotFoundError,
  ChangeScope,
  CycleError,
  DeletedConflictError,
  DuplicateIdError,
  MergeIntoDescendantError,
  NotDeletedError,
  ParentDeletedError,
  ParentNotFoundError,
  ProcessorRejection,
  WorkspaceMismatchError,
} from '@/data/api'
import { aliasesProp, typesProp } from '@/data/properties'
import { cycleScanSql, SUBTREE_SQL } from '@/data/internals/treeQueries'
import { runConsistencyAudit } from '@/plugins/data-integrity/audit'
import type { Repo } from '@/data/repo'

const WS = 'ws-1'
const ROOT = 'root'

// ──── op descriptors ────
// Targets are indices resolved modulo the known-id list at execution
// time. `nonRoot` selectors skip the seed root so a single early
// delete/merge of the root doesn't turn the whole sequence into
// error-path noise.

type Pos = {kind: 'first'} | {kind: 'last'} | {kind: 'before' | 'after'; sibling: number}

type OpSpec =
  | {op: 'createChild'; parent: number; pos: Pos; content: string}
  | {op: 'createSiblingAbove' | 'createSiblingBelow'; sibling: number; content: string}
  | {op: 'insertChildren'; parent: number; contents: string[]; pos: Pos}
  | {op: 'move'; id: number; parent: number; pos: Pos}
  | {op: 'setContent'; id: number; content: string}
  | {op: 'indent' | 'outdent' | 'deleteBlock' | 'restoreBlock'; id: number}
  | {op: 'moveVertical'; id: number; direction: -1 | 1}
  | {op: 'split'; id: number; before: string; after: string}
  | {op: 'merge'; into: number; from: number}
  | {op: 'setAlias'; id: number; alias: number; clear: boolean}
  | {op: 'setType'; id: number; type: number; clear: boolean}
  | {op: 'setReferences'; id: number; refs: Array<{target: number; aliased: boolean; prop: boolean}>}
  | {op: 'undo'} | {op: 'redo'}

// Tiny alias pool so collisions (and merge-then-undo alias handoffs —
// the block_aliases_workspace_alias_unique replay interaction) happen
// constantly rather than by generation accident.
const ALIAS_POOL = ['ax', 'ay', 'az'] as const
const TYPE_POOL = ['task', 'note'] as const

const sel = fc.nat(31)
const text = fc.string({maxLength: 8})
const posArb: fc.Arbitrary<Pos> = fc.oneof(
  {arbitrary: fc.constant({kind: 'first'} as Pos), weight: 2},
  {arbitrary: fc.constant({kind: 'last'} as Pos), weight: 3},
  {arbitrary: fc.record({kind: fc.constantFrom('before' as const, 'after' as const), sibling: sel}), weight: 2},
)

const opArb: fc.Arbitrary<OpSpec> = fc.oneof(
  {weight: 5, arbitrary: fc.record({op: fc.constant('createChild' as const), parent: sel, pos: posArb, content: text})},
  {weight: 2, arbitrary: fc.record({op: fc.constantFrom('createSiblingAbove' as const, 'createSiblingBelow' as const), sibling: sel, content: text})},
  {weight: 1, arbitrary: fc.record({op: fc.constant('insertChildren' as const), parent: sel, contents: fc.array(text, {minLength: 1, maxLength: 3}), pos: posArb})},
  {weight: 4, arbitrary: fc.record({op: fc.constant('move' as const), id: sel, parent: sel, pos: posArb})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('setContent' as const), id: sel, content: text})},
  {weight: 3, arbitrary: fc.record({op: fc.constantFrom('indent' as const, 'outdent' as const), id: sel})},
  {weight: 2, arbitrary: fc.record({op: fc.constantFrom('deleteBlock' as const, 'restoreBlock' as const), id: sel})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('moveVertical' as const), id: sel, direction: fc.constantFrom(-1 as const, 1 as const)})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('split' as const), id: sel, before: text, after: text})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('merge' as const), into: sel, from: sel})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('setAlias' as const), id: sel, alias: fc.nat(ALIAS_POOL.length - 1), clear: fc.boolean()})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('setType' as const), id: sel, type: fc.nat(TYPE_POOL.length - 1), clear: fc.boolean()})},
  {weight: 2, arbitrary: fc.record({
    op: fc.constant('setReferences' as const),
    id: sel,
    refs: fc.array(fc.record({target: sel, aliased: fc.boolean(), prop: fc.boolean()}), {maxLength: 3}),
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
// combinations — legal fuzz outcomes. A plain `Error` (exactly, not a
// subclass like TypeError) is also accepted as a message-carrying
// domain rejection; anything else fails the property.
const LEGAL_ERRORS = [
  BlockNotFoundError,
  CycleError,
  DeletedConflictError,
  DuplicateIdError,
  MergeIntoDescendantError,
  NotDeletedError,
  ParentDeletedError,
  ParentNotFoundError,
  WorkspaceMismatchError,
]

const assertLegalRejection = (e: unknown, op: OpSpec): void => {
  if (LEGAL_ERRORS.some(cls => e instanceof cls)) return
  // Claiming an alias another live block owns is a legal user-facing
  // rejection (block_aliases_workspace_alias_unique). Only that code —
  // any other ProcessorRejection from the kernel-only runtime is a bug.
  if (e instanceof ProcessorRejection && e.code === 'alias.collision') return
  if (e instanceof Error && e.constructor === Error) return
  throw new Error(`illegal error from ${JSON.stringify(op)}: ${String(e)}`, {cause: e})
}

// ──── execution ────

const pick = (index: number, ids: readonly string[]): string => ids[index % ids.length]
/** Skips the seed root (ids[0]) so destructive ops keep the tree alive. */
const pickNonRoot = (index: number, ids: readonly string[]): string =>
  ids.length === 1 ? ids[0] : ids[1 + (index % (ids.length - 1))]

type ResolvedPos = {kind: 'first'} | {kind: 'last'} | {kind: 'before'; siblingId: string} | {kind: 'after'; siblingId: string}
const resolvePos = (pos: Pos, ids: readonly string[]): ResolvedPos =>
  pos.kind === 'first' || pos.kind === 'last'
    ? pos
    : pos.kind === 'before'
      ? {kind: 'before', siblingId: pick(pos.sibling, ids)}
      : {kind: 'after', siblingId: pick(pos.sibling, ids)}

/** Applies one op; returns ids of any newly created blocks. */
const applyOp = async (repo: Repo, op: OpSpec, ids: readonly string[]): Promise<string[]> => {
  switch (op.op) {
    case 'createChild':
      return [await repo.mutate.createChild({parentId: pick(op.parent, ids), position: resolvePos(op.pos, ids), content: op.content})]
    case 'createSiblingAbove':
      return [await repo.mutate.createSiblingAbove({siblingId: pickNonRoot(op.sibling, ids), content: op.content})]
    case 'createSiblingBelow':
      return [await repo.mutate.createSiblingBelow({siblingId: pickNonRoot(op.sibling, ids), content: op.content})]
    case 'insertChildren':
      return await repo.mutate.insertChildren({
        parentId: pick(op.parent, ids),
        items: op.contents.map(content => ({content})),
        position: resolvePos(op.pos, ids),
      })
    case 'move':
      await repo.mutate.move({id: pickNonRoot(op.id, ids), parentId: pick(op.parent, ids), position: resolvePos(op.pos, ids)})
      return []
    case 'setContent':
      await repo.mutate.setContent({id: pick(op.id, ids), content: op.content})
      return []
    case 'indent':
      await repo.mutate.indent({id: pickNonRoot(op.id, ids)})
      return []
    case 'outdent':
      await repo.mutate.outdent({id: pickNonRoot(op.id, ids)})
      return []
    case 'deleteBlock':
      await repo.mutate.delete({id: pickNonRoot(op.id, ids)})
      return []
    case 'restoreBlock':
      await repo.mutate.restore({id: pickNonRoot(op.id, ids)})
      return []
    case 'moveVertical':
      await repo.mutate.moveVertical({id: pickNonRoot(op.id, ids), direction: op.direction})
      return []
    case 'split':
      return [await repo.mutate.split({id: pickNonRoot(op.id, ids), before: op.before, after: op.after})]
    case 'merge':
      await repo.mutate.merge({intoId: pick(op.into, ids), fromId: pickNonRoot(op.from, ids)})
      return []
    case 'setAlias':
      await repo.mutate.setProperty({
        id: pick(op.id, ids),
        schema: aliasesProp,
        value: op.clear ? [] : [ALIAS_POOL[op.alias]],
      })
      return []
    case 'setType':
      await repo.mutate.setProperty({
        id: pick(op.id, ids),
        schema: typesProp,
        value: op.clear ? [] : [TYPE_POOL[op.type]],
      })
      return []
    case 'setReferences': {
      // `references` is a bookkeeping field with no kernel mutator (the
      // references plugin writes it via tx.update post-commit); writing
      // it directly exercises the block_references triggers + the
      // canonicalization path, which no other op reaches. Targets may be
      // tombstones — dangling targets are legal at this layer (only the
      // full audit's dangling_refs check polices them).
      const sourceId = pick(op.id, ids)
      const references = op.refs.map(r => {
        const targetId = pick(r.target, ids)
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

const sweepInvariants = async (db: TestDb['db'], ids: readonly string[]): Promise<void> => {
  const cycles = await db.getAll<{start_id: string}>(cycleScanSql(ids.length), [...ids])
  expect(cycles, 'structural cycle').toEqual([])

  const orphans = await db.getAll<{id: string}>(
    `SELECT b.id FROM blocks b
      WHERE b.deleted = 0 AND b.parent_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM blocks p WHERE p.id = b.parent_id AND p.deleted = 0)`,
  )
  expect(orphans, 'live block under missing/deleted parent').toEqual([])

  const collisions = await db.getAll<{parent_id: string | null; order_key: string; n: number}>(
    `SELECT parent_id, order_key, COUNT(*) AS n FROM blocks
      WHERE deleted = 0 GROUP BY parent_id, order_key HAVING n > 1`,
  )
  expect(collisions, 'order-key collision among live siblings').toEqual([])

  const foreign = await db.getAll<{id: string}>(
    'SELECT id FROM blocks WHERE workspace_id != ?', [WS],
  )
  expect(foreign, 'block outside the seeded workspace').toEqual([])

  // Differential: recursive CTE vs a plain JS pre-order walk. The CTE
  // orders siblings by the path encoding of (order_key, hex(id)) which
  // must agree with a bytewise (order_key, id) sort.
  const rows = await db.getAll<RawRow>('SELECT id, parent_id, order_key, deleted, workspace_id FROM blocks')
  const live = rows.filter(r => r.deleted === 0)
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
  if (live.some(r => r.id === ROOT)) walk(ROOT, 0)
  const subtree = await db.getAll<{id: string; depth: number}>(SUBTREE_SQL, [ROOT])
  expect(subtree.map(r => ({id: r.id, depth: r.depth})), 'SUBTREE_SQL vs JS walk').toEqual(expected)

  await sweepDerivedIndexes(db)
}

/** User-visible state of the live tree, for undo/redo round-trips. */
const liveSnapshot = async (db: TestDb['db']): Promise<string> => {
  const rows = await db.getAll(
    `SELECT id, parent_id, order_key, content, properties_json, references_json
       FROM blocks WHERE deleted = 0 ORDER BY id`,
  )
  return JSON.stringify(rows)
}

const drain = async (fn: () => Promise<boolean>): Promise<number> => {
  for (let n = 0; n < 300; n++) {
    if (!(await fn())) return n
  }
  throw new Error('undo/redo did not bottom out after 300 steps')
}

// ──── the property ────

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await inFlightCase?.catch(() => {})
  await sharedDb.cleanup()
})

/** Deep-tier hazard: fast-check's `interruptAfterTimeLimit` resolves
 *  `fc.assert` WITHOUT awaiting the case that's currently executing
 *  (verified empirically — the abandoned case keeps running and writing
 *  to the shared DB afterwards). Anything that touches the DB after the
 *  property — later tests in this file, `afterAll` cleanup — must
 *  barrier on this first. The abandoned case's own verdict is
 *  deliberately discarded (that's what interrupt means), hence the
 *  swallowed rejection. */
let inFlightCase: Promise<void> | null = null

type CaseArgs = {ops: OpSpec[]; withUndoRedo: boolean; prngSeed: number}

const runCase = async ({ops, withUndoRedo, prngSeed}: CaseArgs): Promise<void> => {
  // Seeded LCG over Math.random: the only nondeterminism in the
  // stack is order-key jitter; pinning it makes shrink/replay sound.
  let lcg = prngSeed
  const realRandom = Math.random
  Math.random = () => {
    lcg = (lcg * 48271) % 2147483647
    return lcg / 2147483647
  }
  try {
          await resetTestDb(sharedDb.db)
          const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
          repo.setActiveWorkspaceId(WS)
          await repo.tx(async tx => {
            await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0'})
          }, {scope: ChangeScope.BlockDefault})
          // The seed tx records its own undo entry; drop it so undo-all
          // bottoms out AT the seed state rather than one step before it.
          repo.undoManager?.clear()

          const seedSnap = await liveSnapshot(sharedDb.db)
          const ids: string[] = [ROOT]
          let ranUndoRedo = false
          for (const op of ops) {
            if ((op.op === 'undo' || op.op === 'redo') && !withUndoRedo) continue
            if (op.op === 'undo' || op.op === 'redo') ranUndoRedo = true
            try {
              ids.push(...await applyOp(repo, op, ids))
            } catch (e) {
              assertLegalRejection(e, op)
            }
            await sweepInvariants(sharedDb.db, ids)
          }

          const finalSnap = await liveSnapshot(sharedDb.db)
          await drain(() => repo.undo())
          expect(await liveSnapshot(sharedDb.db), 'undo-all returns to seed state').toBe(seedSnap)
          await sweepInvariants(sharedDb.db, ids)

          await drain(() => repo.redo())
          if (!ranUndoRedo) {
            expect(await liveSnapshot(sharedDb.db), 'redo-all returns to final state').toBe(finalSnap)
          }
          await sweepInvariants(sharedDb.db, ids)

          const audit = await runConsistencyAudit(sharedDb.db, WS, 0)
          expect(audit.anomalies, `consistency audit: ${JSON.stringify(audit.checks)}`).toBe(0)
  } finally {
    Math.random = realRandom
  }
}

describe('kernel mutator sequences', () => {
  it('preserve structural invariants and undo/redo round-trips', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async args => {
        const run = runCase(args)
        inFlightCase = run
        await run
      }),
      fuzzParams(10),
    )
  }, fuzzTestTimeout())

  // Non-vacuity canary: the mirror sweeps above only bite if the op set
  // actually populates the derived indexes. The original suite shipped
  // with a references mirror that passed on permanently-empty
  // references_json — this pins each index non-empty under a crafted
  // sequence so that failure mode can't silently return.
  it('op set populates every trigger-maintained derived index', async () => {
    // Barrier against a deep-tier interrupt's abandoned case — see the
    // inFlightCase docblock. Without this, that case's writes race this
    // test's reset/seed on the shared DB (observed as DuplicateIdError on
    // the seed root and phantom rows in the subtree sweep).
    await inFlightCase?.catch(() => {})
    await resetTestDb(sharedDb.db)
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    repo.setActiveWorkspaceId(WS)
    await repo.tx(async tx => {
      await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})

    const ids = [ROOT]
    for (const op of [
      {op: 'createChild', parent: 0, pos: {kind: 'last'}, content: 'searchable text'},
      {op: 'setAlias', id: 1, alias: 0, clear: false},
      {op: 'setType', id: 1, type: 0, clear: false},
      {op: 'setReferences', id: 1, refs: [{target: 0, aliased: true, prop: true}]},
    ] satisfies OpSpec[]) {
      ids.push(...await applyOp(repo, op, ids))
    }

    for (const table of ['block_aliases', 'block_types', 'block_references', 'blocks_fts']) {
      const rows = await sharedDb.db.getAll<{n: number}>(`SELECT COUNT(*) AS n FROM ${table}`)
      expect(rows[0].n, `${table} populated by the op set`).toBeGreaterThan(0)
    }
    await sweepInvariants(sharedDb.db, ids)
  })
})
