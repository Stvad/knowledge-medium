// @vitest-environment node
/**
 * Differential fuzz suite for the VISIBLE-children view — the outline view
 * that hides recognized property field rows (§9 of
 * docs/properties-as-blocks-migration.html). Tier mechanics: `src/test/fuzz.ts`.
 *
 * Which halves are independent decides which oracles are worth having. Both
 * views read the SAME stamped columns for recognition conditions (1) and (2) —
 * `is_field_form` and `reference_target_id`, plus `parent_id IS NOT NULL` —
 * and split only on condition (3), "does the target name a definition":
 *  - JS: `visibleChildrenOf` → `tx.childrenOf(…, {hidePropertyChildren})` →
 *    `isPropertyFieldInstance` with the tx's registry checker
 *    (`isResolvableFieldDefinition(resolver.resolveField(id))`), fed by the
 *    user-schemas projector's parse of definition rows plus the code seeds.
 *  - SQL: `recognizedFieldRowSql` — a `block_types` 'property-schema' tag in
 *    the row's workspace, or membership in the bound registry seed-id list.
 * A SQL-vs-JS differential therefore tests that one leg and is blind to the
 * shared input, so the input gets an oracle of its own. After every op:
 *
 *  1. STAMP — every row's `(reference_target_id, is_field_form)` equals
 *     `deriveReferenceColumns(content)` recomputed now. A write path that
 *     leaves them stale fools both views identically. The ops reach the
 *     columns through each writer that owns them: the same-tx derive on
 *     `repo.tx`, the arrival processor for a peer's write (staged into
 *     `blocks_synced` and materialized by the observer — NOT a raw `blocks`
 *     write, which is the pre-upgrade shape that `rematerialize-workspace`
 *     repairs), and undo/redo replay. It checks the pipeline, not the
 *     grammar: `referenceParser.fuzz` owns the parse.
 *  2. CHILDREN — for every live block in the active workspace,
 *     `VISIBLE_CHILDREN_SQL` bound with the live `registrySeedParams` (what
 *     `core.children` runs) returns exactly `visibleChildrenOf`'s ids, in order.
 *  3. SUBTREE — for every live block, `VISIBLE_SUBTREE_SQL`'s (id, depth) rows
 *     equal a pre-order walk from it over oracle 2's JS lists: the recursive
 *     descent's prune-at-a-field-row, never-prune-the-root and stop-at-deleted
 *     must agree with the flat view.
 * 2 and 3 poll, because the registry is reactive: the projector republishes
 * asynchronously after a definition write, while `block_types` moves inside it.
 *
 * Out of scope, each owned elsewhere: handle reactivity (the predicate's
 * undeclared deps are #667 — oracles 2 and 3 read fresh SQL, never a handle);
 * an occupied seed slot (#670 — the generator never writes at a seed id);
 * `[[alias]]` field rows (late binding, `referencesRecompute.fuzz`);
 * background workspaces (the JS resolver fails closed without that
 * workspace's registry, so only the active one is compared); flipped
 * workspaces (their dual-write processors are the bag↔child suite's).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { releaseTestRepos } from '@/data/test/testRepoScope'
import { drain } from '@/data/test/fuzzKernelHarness'
import {
  ChangeScope,
  CycleError,
  NotDeletedError,
  ParentDeletedError,
  type BlockData,
} from '@/data/api'
import { ProcessorRejection } from '@/data/api/sameTxProcessor'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams, parseBlockRow, type BlockRow } from '@/data/blockSchema'
import { registrySeedParams } from '@/data/internals/kernelQueries'
import { deriveReferenceColumns } from '@/data/internals/referenceTargetProcessor'
import { VISIBLE_CHILDREN_SQL, VISIBLE_SUBTREE_SQL } from '@/data/internals/treeQueries'
import { USER_SCHEMAS_PROJECTOR_ID } from '@/data/userSchemasService'
import { visibleChildrenOf } from '@/data/visibleChildren'
import type { Repo } from '@/data/repo'

const WS = 'ws-visible'
const WS2 = 'ws-visible-foreign'

/** UUID-shaped, so every id can sit in the labelled `[label](((id)))` form,
 *  whose parser is UUID-only; the leading hex digit says what the id is. */
const uuid = (kind: 'a' | 'b' | 'd' | 'e' | 'f', n: number): string =>
  `${kind}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const ROOT = uuid('a', 0)
const DEF_SLOTS = [1, 2, 3].map(n => uuid('d', n))
const FOREIGN_DEF = uuid('f', 1)
/** Never written: a field row targeting it is an honest "unknown field". */
const UNKNOWN_ID = uuid('e', 1)
/** Two names over three slots, so a shadowed loser is a common state. */
const NAMES = ['status', 'priority'] as const
/** Valid fractional keys from a tiny set, so `(order_key, id)` ties are
 *  common — the subtree's path encoding breaks them on `hex(id)`. */
const ORDER_KEYS = ['a0', 'a1', 'a2'] as const
const WORDS = ['note', 'todo', '::', 'x'] as const

// ──── op descriptors (data-only; targets resolve at execution) ────

type TargetSpec =
  | {to: 'def'; slot: number}
  | {to: 'seed'}
  | {to: 'foreign'}
  | {to: 'unknown'}
  | {to: 'block'; idx: number}

type ContentSpec =
  | {kind: 'text'; word: number}
  | {kind: 'field'; target: TargetSpec; labelled: boolean}
  | {kind: 'ref'; target: TargetSpec}
  | {kind: 'nearMiss'; target: TargetSpec; shape: number}

interface DefSpec {
  /** Index into NAMES; past the end is an empty name. */
  name: number
  preset: 'string' | 'number' | 'unloadable' | 'none'
  validScope: boolean
}

type Via = 'tx' | 'sync'
type ParentSpec = {kind: 'node'; idx: number} | {kind: 'workspace-root'}

type Op =
  | {op: 'create'; parent: ParentSpec; orderKey: number; content: ContentSpec; via: Via}
  | {op: 'setContent'; id: number; content: ContentSpec; via: Via}
  | {op: 'move'; id: number; parent: ParentSpec; orderKey: number}
  | {op: 'delete'; id: number; via: Via}
  | {op: 'restore'; id: number; via: Via}
  | {op: 'putDef'; slot: number; def: DefSpec; via: Via}
  | {op: 'untypeDef'; slot: number; via: Via}
  | {op: 'undo'}
  | {op: 'redo'}

const idx = fc.nat({max: 50})
const viaArb: fc.Arbitrary<Via> = fc.constantFrom('tx', 'sync')
const targetArb: fc.Arbitrary<TargetSpec> = fc.oneof(
  {weight: 6, arbitrary: fc.record({to: fc.constant('def' as const), slot: fc.nat({max: 2})})},
  {weight: 1, arbitrary: fc.constant({to: 'seed' as const})},
  {weight: 1, arbitrary: fc.constant({to: 'foreign' as const})},
  {weight: 1, arbitrary: fc.constant({to: 'unknown' as const})},
  {weight: 1, arbitrary: fc.record({to: fc.constant('block' as const), idx})},
)
const contentArb: fc.Arbitrary<ContentSpec> = fc.oneof(
  {weight: 3, arbitrary: fc.record({kind: fc.constant('text' as const), word: fc.nat({max: WORDS.length - 1})})},
  {weight: 5, arbitrary: fc.record({kind: fc.constant('field' as const), target: targetArb, labelled: fc.boolean()})},
  {weight: 1, arbitrary: fc.record({kind: fc.constant('ref' as const), target: targetArb})},
  {weight: 1, arbitrary: fc.record({kind: fc.constant('nearMiss' as const), target: targetArb, shape: fc.nat({max: 4})})},
)
/** KNOWN ISSUE (fuzz): #1202 — the views disagree on a block tagged
 *  'property-schema' that the registry cannot build a definition from: SQL
 *  recognizes the tag, the JS checker needs parsed metadata AND a buildable
 *  schema. Counterexamples: an invalid change scope (`putDef` with
 *  `validScope: false`, then a field row targeting it — SQL hides the row,
 *  JS shows it) and an unloadable or missing preset (same shape). Only
 *  buildable definitions are generated until that lands; flip this then. */
const GENERATE_UNBUILDABLE_DEFINITIONS = false

const defArb: fc.Arbitrary<DefSpec> = GENERATE_UNBUILDABLE_DEFINITIONS
  ? fc.record({
    name: fc.nat({max: NAMES.length}),
    preset: fc.constantFrom('string', 'number', 'unloadable', 'none'),
    validScope: fc.boolean(),
  })
  : fc.record({
    name: fc.nat({max: NAMES.length - 1}),
    preset: fc.constantFrom('string', 'number'),
    validScope: fc.constant(true),
  })
const parentArb: fc.Arbitrary<ParentSpec> = fc.oneof(
  {weight: 9, arbitrary: fc.record({kind: fc.constant('node' as const), idx})},
  {weight: 1, arbitrary: fc.constant({kind: 'workspace-root' as const})},
)
const orderKeyArb = fc.nat({max: ORDER_KEYS.length - 1})

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {weight: 6, arbitrary: fc.record({op: fc.constant('create' as const), parent: parentArb, orderKey: orderKeyArb, content: contentArb, via: viaArb})},
  {weight: 3, arbitrary: fc.record({op: fc.constant('setContent' as const), id: idx, content: contentArb, via: viaArb})},
  {weight: 2, arbitrary: fc.record({op: fc.constant('move' as const), id: idx, parent: parentArb, orderKey: orderKeyArb})},
  {weight: 1, arbitrary: fc.record({op: fc.constant('delete' as const), id: idx, via: viaArb})},
  {weight: 1, arbitrary: fc.record({op: fc.constant('restore' as const), id: idx, via: viaArb})},
  {weight: 3, arbitrary: fc.record({op: fc.constant('putDef' as const), slot: fc.nat({max: 2}), def: defArb, via: viaArb})},
  {weight: 1, arbitrary: fc.record({op: fc.constant('untypeDef' as const), slot: fc.nat({max: 2}), via: viaArb})},
  {weight: 1, arbitrary: fc.constant({op: 'undo' as const})},
  {weight: 1, arbitrary: fc.constant({op: 'redo' as const})},
)

const caseArb = fc.record({
  ops: fc.array(opArb, {minLength: 1, maxLength: 25}),
  prngSeed: fc.integer({min: 1, max: 2 ** 31 - 2}),
})

// ──── execution ────

interface Universe {
  repo: Repo
  db: TestDb['db']
  /** A code seed's deterministic definition id: recognized through the
   *  bound seed list on the SQL side and the declaration on the JS side,
   *  with no row ever written there (#670 is the occupied-slot case). */
  seedId: string
  /** Every block id written so far — ROOT first. */
  nodes: string[]
  nextBlock: number
  syncClock: number
}

const resolveTarget = (u: Universe, t: TargetSpec): string => {
  switch (t.to) {
    case 'def': return DEF_SLOTS[t.slot]!
    case 'seed': return u.seedId
    case 'foreign': return FOREIGN_DEF
    case 'unknown': return UNKNOWN_ID
    case 'block': return u.nodes[t.idx % u.nodes.length]!
  }
}

const renderContent = (u: Universe, c: ContentSpec): string => {
  switch (c.kind) {
    case 'text': return WORDS[c.word]!
    case 'field': {
      const id = resolveTarget(u, c.target)
      return c.labelled ? `::[label](((${id})))` : `::((${id}))`
    }
    case 'ref': return `((${resolveTarget(u, c.target)}))`
    case 'nearMiss': {
      const id = resolveTarget(u, c.target)
      return [`:: ((${id}))`, `::((${id})) x`, `x ::((${id}))`, `::::((${id}))`, `::((${id}))\n`][c.shape]!
    }
  }
}

const definitionBag = (def: DefSpec): Record<string, unknown> => ({
  types: ['property-schema'],
  'property-schema:name': NAMES[def.name] ?? '',
  ...(def.preset === 'none' ? {} : {
    'property-schema:preset': def.preset === 'unloadable' ? 'preset-whose-plugin-is-not-loaded' : def.preset,
  }),
  ...(def.validScope ? {} : {'property-schema:change-scope': 'not-a-change-scope'}),
})

const readRow = async (db: TestDb['db'], id: string): Promise<BlockData | null> => {
  const row = await db.getOptional<BlockRow>('SELECT * FROM blocks WHERE id = ?', [id])
  return row === null ? null : parseBlockRow(row)
}

const tx = (u: Universe, fn: Parameters<Repo['tx']>[0]): Promise<unknown> =>
  u.repo.tx(fn, {scope: ChangeScope.BlockDefault})

/** A peer's write that WINS: staged into `blocks_synced` and materialized by
 *  the observer, which runs the arrival processors. A losing arrival
 *  exercises the reconcile gate rather than those processors, and is the
 *  reconcile suite's. So `ps_crud` is cleared first (our own uploads have
 *  drained), and the stamp outranks the row it overwrites — a local write
 *  stamps `max(now, before.updatedAt + 1)` (invariant I3), so after one peer
 *  write a local edit already sits past any fixed peer clock. */
const applyFromPeer = async (u: Universe, next: BlockData): Promise<void> => {
  await u.db.execute('DELETE FROM ps_crud')
  const current = await readRow(u.db, next.id)
  u.syncClock = Math.max(u.syncClock, current?.updatedAt ?? 0) + 1
  await u.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
    ...next, updatedAt: u.syncClock, userUpdatedAt: u.syncClock, updatedBy: 'peer',
  }))
  await u.repo.flushSyncObserver()
  const landed = await readRow(u.db, next.id)
  // Non-vacuity: a held or dropped arrival would leave the sync ops testing nothing.
  expect(
    landed && {content: landed.content, parentId: landed.parentId, deleted: landed.deleted, properties: landed.properties},
    `peer write to ${next.id} landed`,
  ).toEqual({content: next.content, parentId: next.parentId, deleted: next.deleted, properties: next.properties})
}

const newBlockData = (u: Universe, id: string, parentId: string | null, orderKey: string, content: string,
  properties: Record<string, unknown> = {}): BlockData => ({
  id, workspaceId: WS, parentId, orderKey, content, properties, references: [],
  createdAt: u.syncClock, updatedAt: u.syncClock, userUpdatedAt: u.syncClock,
  createdBy: 'peer', updatedBy: 'peer', deleted: false,
})

const resolveParent = (u: Universe, p: ParentSpec): string | null =>
  p.kind === 'workspace-root' ? null : u.nodes[p.idx % u.nodes.length]!

/** Patch an existing row through `via`. A tx write goes through the kernel
 *  primitive; a peer write replaces the whole row, as sync does. */
const patchRow = async (u: Universe, id: string, via: Via,
  patch: {content?: string; properties?: Record<string, unknown>; deleted?: boolean}): Promise<void> => {
  if (via === 'sync') {
    const current = await readRow(u.db, id)
    if (current === null) return
    await applyFromPeer(u, {...current, ...patch})
    return
  }
  await tx(u, async t => {
    if (patch.deleted === true) return t.delete(id)
    if (patch.deleted === false) return t.restore(id)
    return t.update(id, {
      ...(patch.content !== undefined ? {content: patch.content} : {}),
      ...(patch.properties !== undefined ? {properties: patch.properties} : {}),
    })
  })
}

const applyOp = async (u: Universe, op: Op): Promise<void> => {
  switch (op.op) {
    case 'create': {
      const id = uuid('b', ++u.nextBlock)
      const parentId = resolveParent(u, op.parent)
      const content = renderContent(u, op.content)
      const orderKey = ORDER_KEYS[op.orderKey]!
      if (op.via === 'sync') {
        await applyFromPeer(u, newBlockData(u, id, parentId, orderKey, content))
      } else {
        await tx(u, t => t.create({id, workspaceId: WS, parentId, orderKey, content}))
      }
      u.nodes.push(id)
      return
    }
    case 'setContent':
      return patchRow(u, u.nodes[op.id % u.nodes.length]!, op.via, {content: renderContent(u, op.content)})
    case 'move': {
      const id = u.nodes[op.id % u.nodes.length]!
      const parentId = resolveParent(u, op.parent)
      await tx(u, t => t.move(id, {parentId, orderKey: ORDER_KEYS[op.orderKey]!}))
      return
    }
    case 'delete':
      return patchRow(u, u.nodes[op.id % u.nodes.length]!, op.via, {deleted: true})
    case 'restore':
      return patchRow(u, u.nodes[op.id % u.nodes.length]!, op.via, {deleted: false})
    case 'putDef': {
      const id = DEF_SLOTS[op.slot]!
      const properties = definitionBag(op.def)
      const current = await readRow(u.db, id)
      if (current === null) {
        if (op.via === 'sync') {
          await applyFromPeer(u, newBlockData(u, id, null, 'a0', '', properties))
        } else {
          await tx(u, t => t.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content: '', properties}))
        }
        u.nodes.push(id)
        return
      }
      if (op.via === 'sync') return applyFromPeer(u, {...current, properties, deleted: false})
      await tx(u, async t => {
        if (current.deleted) await t.restore(id, {properties})
        else await t.update(id, {properties})
      })
      return
    }
    case 'untypeDef': {
      const id = DEF_SLOTS[op.slot]!
      const current = await readRow(u.db, id)
      if (current === null) return
      return patchRow(u, id, op.via, {properties: {...current.properties, types: []}})
    }
    case 'undo':
      await u.repo.undo()
      return
    case 'redo':
      await u.repo.redo()
      return
  }
}

/** Rejections the tx surface owes an incoherent op — legal outcomes:
 *  - `CycleError`: a move under its own descendant (`tx.move`'s cycle check);
 *  - `ParentDeletedError`: a create/move under a tombstone;
 *  - `NotDeletedError`: restoring a live row;
 *  - the definition-change processor's refusals
 *    (`propertyDefinitionChangeProcessor.ts`): a re-type it cannot fan out
 *    because the old or new value type does not build, a change to a
 *    definition whose name is contested (both in `REFUSALS`), and a re-type
 *    that would lose a stored value — a field row's value child that the new
 *    type cannot hold.
 *  Anything else is a bug. A peer write is never rejected — sync applies it. */
const LEGAL_DEFINITION_CHANGE_REFUSALS = new Set([
  'property.definition-change.unbuildable',
  'property.definition-change.contested',
  'property.definition-change.unconvertible',
])

const assertLegalRejection = (e: unknown, op: Op): void => {
  if (e instanceof CycleError || e instanceof ParentDeletedError || e instanceof NotDeletedError) return
  if (e instanceof ProcessorRejection && LEGAL_DEFINITION_CHANGE_REFUSALS.has(e.code)) return
  throw new Error(`illegal error from ${JSON.stringify(op)}: ${String(e)}`, {cause: e})
}

// ──── oracles ────

/** The suite never generates an `[[alias]]` span, so a lookup means the
 *  generator or the parser moved — fail loudly rather than guess. */
const NO_ALIAS_LOOKUPS = {
  aliasTargetId: async (alias: string): Promise<string | null> => {
    throw new Error(`unexpected alias-form content resolving [[${alias}]]`)
  },
}

interface StampRow {
  id: string
  workspace_id: string
  content: string
  reference_target_id: string | null
  is_field_form: number | null
}

const sweepStamps = async (db: TestDb['db']): Promise<void> => {
  const rows = await db.getAll<StampRow>(
    'SELECT id, workspace_id, content, reference_target_id, is_field_form FROM blocks ORDER BY id',
  )
  for (const row of rows) {
    const derived = await deriveReferenceColumns(row.content, row.workspace_id, NO_ALIAS_LOOKUPS)
    expect(
      {target: row.reference_target_id, isFieldForm: row.is_field_form === 1},
      `stamp of ${row.id} (content ${JSON.stringify(row.content)})`,
    ).toEqual({target: derived.targetId ?? null, isFieldForm: derived.isFieldForm})
  }
}

/** What each side was looking at, for a divergence report: the row's own
 *  columns, the `block_types` tags on its target, and the registry's answer. */
const explainRows = async (u: Universe, ids: readonly string[]): Promise<string> => {
  const lines: string[] = []
  for (const id of ids) {
    const row = await readRow(u.db, id)
    const target = row?.referenceTargetId ?? null
    const tags = target === null ? [] : await u.db.getAll<{type: string; workspace_id: string}>(
      'SELECT type, workspace_id FROM block_types WHERE block_id = ?', [target],
    )
    const targetRow = target === null ? null : await readRow(u.db, target)
    lines.push(JSON.stringify({
      id, content: row?.content, parentId: row?.parentId, isFieldForm: row?.isFieldForm, target, tags,
      targetProperties: targetRow?.properties, targetDeleted: targetRow?.deleted,
      registry: target === null ? null : u.repo.propertySchemaResolverFor(WS).resolveField(target),
    }))
  }
  return lines.join('\n')
}

const symmetricDiff = (a: readonly string[], b: readonly string[]): string[] =>
  [...a.filter(x => !b.includes(x)), ...b.filter(x => !a.includes(x))]

const compareViews = async (u: Universe): Promise<void> => {
  const live = (await u.db.getAll<{id: string}>(
    'SELECT id FROM blocks WHERE workspace_id = ? AND deleted = 0 ORDER BY id', [WS],
  )).map(r => r.id)
  const seedParams = registrySeedParams(u.repo)

  const jsChildren = new Map<string, string[]>()
  await tx(u, async t => {
    for (const id of live) jsChildren.set(id, (await visibleChildrenOf(t, id)).map(c => c.id))
  })

  for (const id of live) {
    const sql = (await u.db.getAll<{id: string}>(VISIBLE_CHILDREN_SQL, [id, ...seedParams])).map(r => r.id)
    const js = jsChildren.get(id)!
    if (JSON.stringify(sql) !== JSON.stringify(js)) {
      throw new Error(
        `visible children of ${id}: SQL ${JSON.stringify(sql)} vs JS ${JSON.stringify(js)}\n`
        + await explainRows(u, symmetricDiff(sql, js)),
      )
    }
  }

  for (const id of live) {
    const expected: Array<{id: string; depth: number}> = []
    const walk = (node: string, depth: number): void => {
      expected.push({id: node, depth})
      for (const child of jsChildren.get(node) ?? []) walk(child, depth + 1)
    }
    walk(id, 0)
    const sql = (await u.db.getAll<{id: string; depth: number}>(VISIBLE_SUBTREE_SQL, [id, ...seedParams]))
      .map(r => ({id: r.id, depth: r.depth}))
    expect(sql, `visible subtree of ${id} (SQL vs JS walk)`).toEqual(expected)
  }
}

const sweep = async (u: Universe): Promise<void> => {
  await u.repo.awaitProcessors()
  await sweepStamps(u.db)
  // Inner budget well under the smoke tier's 60s test timeout; the projector
  // republishes in tens of ms.
  await vi.waitFor(() => compareViews(u), {timeout: 3000, interval: 25})
}

// ──── the property ────

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await guard.barrier()
  await sharedDb.cleanup()
})

const guard = statefulFuzzGuard()

const openUniverse = async (): Promise<Universe> => {
  await resetTestDb(sharedDb.db)
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}, startSyncObserver: true})
  repo.setActiveWorkspaceId(WS)
  await repo.projectors.handle(USER_SCHEMAS_PROJECTOR_ID)!.whenPrimed(WS)
  const seedIds = JSON.parse(registrySeedParams(repo)[0]) as string[]
  expect(seedIds.length, 'kernel seeds give the SQL seed leg something to bind').toBeGreaterThan(0)

  const u: Universe = {repo, db: sharedDb.db, seedId: seedIds[0]!, nodes: [ROOT], nextBlock: 0, syncClock: 9_000_000_000_000}
  // A definition in ANOTHER workspace: a field row here targeting it must
  // stay visible (§9 — both legs are workspace-guarded).
  await repo.tx(t => t.create({
    id: FOREIGN_DEF, workspaceId: WS2, parentId: null, orderKey: 'a0', content: '',
    properties: definitionBag({name: 0, preset: 'string', validScope: true}),
  }), {scope: ChangeScope.BlockDefault})
  await tx(u, async t => {
    await t.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'root'})
    await t.create({
      id: DEF_SLOTS[0]!, workspaceId: WS, parentId: null, orderKey: 'a1', content: '',
      properties: definitionBag({name: 0, preset: 'string', validScope: true}),
    })
  })
  u.nodes.push(DEF_SLOTS[0]!)
  repo.undoManagerFor(WS).clear()
  repo.undoManagerFor(WS2).clear()
  return u
}

/** Undo everything still undoable. Replay can be refused legally — a peer
 *  deleted the parent a move would go back under — and the entry stays put,
 *  so the drain stops there rather than retrying it. */
const drainUndo = async (u: Universe): Promise<void> => {
  const op: Op = {op: 'undo'}
  try {
    await drain(() => u.repo.undo())
  } catch (e) {
    assertLegalRejection(e, op)
  }
}

const runCase = async (ops: readonly Op[]): Promise<void> => {
  const u = await openUniverse()
  try {
    await sweep(u)
    for (const op of ops) {
      try {
        await applyOp(u, op)
      } catch (e) {
        if ('via' in op && op.via === 'sync') throw e
        assertLegalRejection(e, op)
      }
      await sweep(u)
    }
    await drainUndo(u)
    await sweep(u)
  } finally {
    await releaseTestRepos([u.repo])
  }
}

describe('visible-children view', () => {
  it('SQL and JS agree, and the stamped columns match content, after every op', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, ({ops, prngSeed}) => guard.run(prngSeed, () => runCase(ops))),
      fuzzParams(20),
    )
  }, fuzzTestTimeout())

  // Non-vacuity canary: the differential only bites when the generated states
  // reach every leg — a hidden field row, a visible unknown-field row, an
  // unmarked look-alike (the NULL bit under `NOT (...)` that COALESCE
  // exists for), a pruned nested subtree, a definition from a peer.
  it('the op vocabulary reaches every recognition leg', async () => {
    await guard.barrier()
    const u = await openUniverse()
    try {
      const root = {kind: 'node', idx: 0} as const
      for (const op of [
        {op: 'create', parent: root, orderKey: 0, content: {kind: 'field', target: {to: 'def', slot: 0}, labelled: false}, via: 'tx'},
        {op: 'create', parent: {kind: 'node', idx: 2}, orderKey: 0, content: {kind: 'text', word: 0}, via: 'tx'},
        {op: 'create', parent: root, orderKey: 1, content: {kind: 'field', target: {to: 'unknown'}, labelled: false}, via: 'tx'},
        {op: 'create', parent: root, orderKey: 2, content: {kind: 'field', target: {to: 'seed'}, labelled: true}, via: 'sync'},
        {op: 'create', parent: root, orderKey: 2, content: {kind: 'field', target: {to: 'def', slot: 1}, labelled: false}, via: 'tx'},
        {op: 'putDef', slot: 1, def: {name: 1, preset: 'number', validScope: true}, via: 'sync'},
        {op: 'create', parent: root, orderKey: 0, content: {kind: 'ref', target: {to: 'def', slot: 0}}, via: 'tx'},
      ] satisfies Op[]) {
        await applyOp(u, op)
        await sweep(u)
      }
      const [fieldRow, valueRow, unknownRow] = u.nodes.slice(2)
      const lookAlike = u.nodes.at(-1)
      const visible = (await u.db.getAll<{id: string}>(VISIBLE_CHILDREN_SQL, [ROOT, ...registrySeedParams(u.repo)]))
        .map(r => r.id)
      expect(visible, 'the unmarked look-alike and the unknown-field row stay visible').toEqual([lookAlike, unknownRow])
      const fromField = await u.db.getAll<{id: string}>(VISIBLE_SUBTREE_SQL, [fieldRow!, ...registrySeedParams(u.repo)])
      expect(fromField.map(r => r.id), 'a field row opened directly shows its value child').toEqual([fieldRow, valueRow])
    } finally {
      await releaseTestRepos([u.repo])
    }
  })
})
