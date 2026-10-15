// @vitest-environment node
/**
 * Stateful fuzz suite for the properties-as-blocks DUAL REPRESENTATION
 * (docs/properties-as-blocks-migration.html §5/§7/§9): in a flipped
 * workspace a property value lives both in the owner's `properties_json`
 * cell and in its `::((fieldId))` field row + value children, and every
 * write path must keep the two telling the same story. Sibling suites fuzz
 * ONE write at a time (`propertyChildrenProcessor.fuzz.test.ts`) and the
 * pure value↔content codec (`propertyChildren.fuzz.test.ts`); this one runs
 * SEQUENCES that mix every writer, several ops per transaction, because the
 * bugs in this area were each a particular ORDER of writers (26c92a687:
 * set-then-unset in one tx resurrected the value; b26fdd94b: the eager path
 * reaped a divergent peer the deferred path keeps; 7a34b5120: the two paths
 * stamped the same child differently).
 *
 * Writers, by how they reach the other representation:
 *  - EAGER cell writes (`tx.setProperty` / `unsetProperty` / `setProperties`,
 *    txEngine.ts) write the children inline, then the cell.
 *  - RAW cell writes (`tx.update({properties})`) write only the cell; the
 *    MATERIALIZE processor reconciles children from the tx's NET bag diff.
 *  - CHILD edits (content, delete, move, reorder, a stray child, a marked
 *    `::` child) write only rows; PROJECT re-derives the owner's cell.
 *  - owner delete/restore (restore runs MATERIALIZE's revival path).
 *  - undo/redo, which replays snapshots with no processor at all.
 *  - SYNC-SHAPED raw `db.writeTransaction` writes (`tx_context.source` NULL,
 *    so no same-tx processor and no parent-liveness trigger): a peer's
 *    duplicate field row, a value edit that arrives without (or with) its
 *    owner's cell, a cell that arrives without its children, a live child
 *    under a tombstone, a peer's subtree delete / partial restore. The
 *    arrival path deliberately does NOT re-project (syncObserver
 *    materialize.ts, "Not repaired here"), so these may leave a pair
 *    incoherent; the suite waives exactly the pairs they touch and checks
 *    that the next LOCAL write to the pair converges it.
 * A case is either `local` (no raw arrivals; undo/redo plus an undo-all /
 * redo-all round trip) or `sync` (raw arrivals; no undo, whose replay over
 * an arrival is the separate #227 question).
 *
 * Oracles, after every transaction:
 *  P  PROJECTION AGREEMENT — for every live block and registered property,
 *     the cell equals the value its live field rows project to. The row
 *     SELECTION is this suite's own SQL (bit + target, live, `(order_key,
 *     id)`); the value-level rules are the pure §9 helpers
 *     (`unionValuesAcrossFieldRows`, `childContentsToEncodedPropertyValue`)
 *     that the codec suite already pins — what P tests is the WIRING: that
 *     every writer above leaves the cell where the children put it.
 *  Q  QUIESCENCE — re-running PROJECT (`reprojectOwnersForRowStates`,
 *     'full') over every field row, and MATERIALIZE
 *     (`materializePropertyChildrenForExistingRow`) over every pair a cell
 *     write just converged, writes nothing (§5 invariant 1, idempotence).
 *     MATERIALIZE is re-run only where a cell write is the last word: a
 *     child edit may legitimately leave a non-canonical spelling (` 1 ` for
 *     1), which projects correctly and which MATERIALIZE would rewrite.
 *  D  no two live field rows for one (owner, property) — except where a
 *     child edit or an arrival could have minted one (a marked `::` child,
 *     a moved row, a peer's field row) and no cell write to that property
 *     has collapsed it since: §9 treats duplicates as a transient conflict
 *     that `upsertFieldRow` folds on the next cell write, not one any
 *     processor repairs on a tree edit.
 *  O  no live row under a missing/tombstoned parent, except rows an
 *     arrival placed there (sync-apply skips the parent-liveness trigger).
 *  I  INTENT — for a pair written only by cell writers in a tx, the cell
 *     ends at the LAST write (absent for an unset). Two carve-outs, both the
 *     accepted single-pass wrinkle in propertyChildrenProcessor.ts's
 *     docblock (MATERIALIZE diffs the tx's net bag):
 *       - an eager write followed by a raw bag write to the same key is
 *         order-blind, so the cell may end at any value written in the tx
 *         (or the start value);
 *       - a pair whose owner ALSO had its children edited in the same tx is
 *         not checked for intent at all — a cell write beats a later
 *         same-tx child edit (MATERIALIZE re-reconciles from the cell), so
 *         "last write" does not hold there either. P still applies.
 *     An owner restored from a tombstone keeps every key the tx did not
 *     write (MATERIALIZE's revival re-materializes the bag rather than
 *     letting PROJECT read the tombstoned children as "unset"), unless an
 *     arrival had already waived the pair.
 *  A  a rejected transaction (a legal kernel rejection, or MATERIALIZE
 *     refusing a cell value no value child can carry) leaves the db
 *     byte-identical.
 *  U  (local cases) undo-all restores the seed rows exactly and tombstones
 *     everything created since; redo-all restores the final state.
 *
 * Every op targets rows by (owner, property, index) resolved at run time,
 * so shrinking keeps the remaining ops meaningful. Order-key jitter is the
 * only nondeterminism and `statefulFuzzGuard` pins it; ids come from the
 * test repo's counter, so replays are exact (docs/fuzzing.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import {
  ChangeScope,
  codecs,
  defineProperty,
  type AnyPropertySchema,
  type BlockData,
  type Tx,
} from '@/data/api'
import { kernelValuePresetCoresById } from '@/data/kernelValuePresetCores'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { assertLegalKernelRejection, drain } from '@/data/test/fuzzKernelHarness'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import { keysBetween } from '@/data/orderKey'
import { deleteSubtreeInTx } from '@/data/subtreeDelete'
import {
  childContentsToEncodedPropertyValue,
  encodedPropertyValueToChildContents,
  propertyFieldContent,
  unionValuesAcrossFieldRows,
} from '@/data/propertyChildren'
import type { Repo } from '@/data/repo'
import { jsonValuesEqual } from './jsonCanonical'
import { deriveReferenceColumns } from './referenceTargetProcessor'
import {
  materializePropertyChildrenForExistingRow,
  reprojectOwnersForRowStates,
  type ProjectableRow,
} from './propertyChildrenProcessor'

const WS = 'ws-dual-write-fuzz'
const ROOT = 'root'
const OWNERS = ['o0', 'o1', 'o2'] as const

// ──── universe: one property per codec shape the reconciler branches on ────

const statusSchema = defineProperty<string>('status', {
  codec: codecs.string, defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const countSchema = defineProperty<number>('count', {
  codec: codecs.number, defaultValue: 0, changeScope: ChangeScope.BlockDefault,
})
const flagSchema = defineProperty<boolean>('flag', {
  codec: codecs.boolean, defaultValue: false, changeScope: ChangeScope.BlockDefault,
})
const relatedSchema = defineProperty<string>('related', {
  codec: codecs.ref(), defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
/** Multi-valued, so sequences reach `reconcileMemberValueChildren` (members
 *  matched by value, surplus reaped, slots permuted). */
const tagsSchema = defineProperty<readonly string[]>('tags', {
  codec: kernelValuePresetCoresById['string-list'].build(),
  defaultValue: [], changeScope: ChangeScope.BlockDefault,
})

const KINDS = ['status', 'count', 'flag', 'related', 'tags'] as const
type Kind = typeof KINDS[number]
const SCHEMAS: Record<Kind, {schema: AnyPropertySchema; fieldId: string}> = {
  status: {schema: statusSchema, fieldId: 'field-status'},
  count: {schema: countSchema, fieldId: 'field-count'},
  flag: {schema: flagSchema, fieldId: 'field-flag'},
  related: {schema: relatedSchema, fieldId: 'field-related'},
  tags: {schema: tagsSchema, fieldId: 'field-tags'},
}
const KIND_BY_FIELD = new Map(KINDS.map(kind => [SCHEMAS[kind].fieldId, kind]))
/** A marked `::` row whose definition does not resolve: not a field row
 *  (§9 condition 3), and — bit set — not a value candidate either. */
const UNKNOWN_FIELD_ID = 'field-unknown'

/** Same shape as the processor's (unexported) lookups — see the identical
 *  hand-built pair in propertyChildrenProcessor.fuzz.test.ts. */
const lookups = {
  resolveFieldSchema: (fieldId: string) => {
    const kind = KIND_BY_FIELD.get(fieldId)
    return kind === undefined ? undefined : SCHEMAS[kind].schema
  },
  resolveNameSchema: (name: string) => {
    const kind = KINDS.find(k => SCHEMAS[k].schema.name === name)
    return kind === undefined ? undefined : {...SCHEMAS[kind].schema, fieldId: SCHEMAS[kind].fieldId}
  },
}

// ──── op vocabulary ────

type ContentSpec =
  | {c: 'value'; kind: Kind; value: unknown}
  /** A valid value spelled non-canonically — projects, but is not what the
   *  encoder would write. */
  | {c: 'padded'; kind: Kind; value: unknown}
  | {c: 'text'; text: string}
  | {c: 'marked'; kind: Kind}
  | {c: 'markedUnknown'}

/** A top-level owner, or (flat §9 recognition: any block hosts field rows)
 *  the `nested`-th value row under it, acting as an owner in its own right. */
type OwnerSel = {top: number; nested?: number}
/** The `pick`-th live field row (any marked row) or value row (an unmarked
 *  child of a marked row) under owner `within`, or anywhere when null —
 *  chosen among rows that EXIST, so tree edits rarely resolve to nothing. */
type RowSel = {within: number | null; level: 'field' | 'value'; pick: number}

type LocalOp =
  | {op: 'set'; owner: OwnerSel; kind: Kind; value: unknown}
  | {op: 'unset'; owner: OwnerSel; kind: Kind}
  | {op: 'setMany'; owner: OwnerSel; sets: {kind: Kind; value: unknown}[]; unsets: Kind[]}
  | {op: 'rawBag'; owner: OwnerSel; edits: {kind: Kind; value: unknown; remove: boolean}[]}
  | {op: 'editContent'; row: RowSel; content: ContentSpec}
  | {op: 'deleteRow'; row: RowSel}
  /** Under `dest`'s first field row for `kind` (a value moving between
   *  properties or owners — or, when `row` is the same field row's value, a
   *  reorder), or straight under the owner when it has none. */
  | {op: 'moveRow'; row: RowSel; dest: {owner: OwnerSel; kind: Kind}; pos: 'first' | 'last'}
  | {op: 'addChild'; parent: RowSel | {owner: OwnerSel}; content: ContentSpec; pos: 'first' | 'last'}
  /** The `pick`-th LIVE top owner. */
  | {op: 'deleteOwner'; pick: number}
  /** The `pick`-th TOMBSTONED top owner. */
  | {op: 'restoreOwner'; pick: number}

type RawOp =
  | {op: 'rawDupField'; top: number; kind: Kind; values: ContentSpec[]; key: 'first' | 'last' | 'tie'; peerCell: boolean}
  | {op: 'rawContent'; row: RowSel; content: ContentSpec; withCell: boolean}
  | {op: 'rawDelete'; row: RowSel; subtree: boolean; withCell: boolean}
  | {op: 'rawCell'; top: number; kind: Kind; value: unknown; remove: boolean}
  | {op: 'rawOrphan'; top: number; kind: Kind; content: ContentSpec}
  | {op: 'rawDeleteOwner'; pick: number}
  | {op: 'rawRestoreOwner'; pick: number}

const LOCAL_OPS = [
  'set', 'unset', 'setMany', 'rawBag', 'editContent', 'deleteRow', 'moveRow', 'addChild', 'deleteOwner', 'restoreOwner',
] as const satisfies readonly LocalOp['op'][]
const RAW_OPS = [
  'rawDupField', 'rawContent', 'rawDelete', 'rawCell', 'rawOrphan', 'rawDeleteOwner', 'rawRestoreOwner',
] as const satisfies readonly RawOp['op'][]

type TxSpec = {t: 'batch'; ops: LocalOp[]} | {t: 'undo'} | {t: 'redo'} | {t: 'raw'; op: RawOp}
type Mode = 'local' | 'sync'

// ──── arbitraries ────

const finiteArb = fc.double({noNaN: true, noDefaultInfinity: true}).filter(n => !Object.is(n, -0))
const REF_POOL = ['o0', 'o1', ROOT, 'gone1'] as const
const KIND_ARB = fc.constantFrom(...KINDS)
const TOP_ARB = fc.nat(OWNERS.length - 1)

const valueArb = (kind: Kind): fc.Arbitrary<unknown> => {
  switch (kind) {
    case 'status': return fc.oneof(
      {weight: 4, arbitrary: fc.string({maxLength: 6})},
      // Strings that look like machinery or like another codec's value.
      {weight: 1, arbitrary: fc.constantFrom('', ' a ', '((o0))', '[[ax]]', '::((field-count))', 'true', '7')},
    )
    case 'count': return fc.oneof(fc.integer({min: -3, max: 3}), finiteArb)
    case 'flag': return fc.boolean()
    case 'related': return fc.constantFrom(...REF_POOL)
    // Repeats and empties on purpose: multiplicity is part of a list's
    // value, and an empty list is a value rather than an absent key.
    case 'tags': return fc.array(fc.constantFrom('a', 'b', 'c'), {maxLength: 3})
  }
}
/** One value-child's worth: a whole scalar, or one list member. */
const memberArb = (kind: Kind): fc.Arbitrary<unknown> =>
  kind === 'tags' ? fc.constantFrom('a', 'b', 'c', 'd') : valueArb(kind)

/** Every case has a HOT owner and property most ops aim at: blind targets
 *  over 3 owners × 5 properties seldom meet, and the bugs this suite hunts
 *  need several writers on ONE pair, often in one tx. */
interface Focus {top: number; kind: Kind}

const opArbs = ({top, kind}: Focus) => {
  const hotKind = fc.oneof({weight: 3, arbitrary: fc.constant(kind)}, {weight: 2, arbitrary: KIND_ARB})
  const hotTop = fc.oneof({weight: 3, arbitrary: fc.constant(top)}, {weight: 1, arbitrary: TOP_ARB})
  const owner: fc.Arbitrary<OwnerSel> = fc.oneof(
    {weight: 8, arbitrary: hotTop.map(t => ({top: t}))},
    {weight: 1, arbitrary: fc.record({top: hotTop, nested: fc.nat(3)})},
  )
  const row: fc.Arbitrary<RowSel> = fc.record({
    within: fc.oneof({weight: 4, arbitrary: hotTop}, {weight: 1, arbitrary: fc.constant(null)}),
    level: fc.oneof({weight: 1, arbitrary: fc.constant('field' as const)}, {weight: 2, arbitrary: fc.constant('value' as const)}),
    pick: fc.nat(5),
  })
  const content: fc.Arbitrary<ContentSpec> = fc.oneof(
    {weight: 6, arbitrary: hotKind.chain(k => memberArb(k).map(value => ({c: 'value' as const, kind: k, value})))},
    {weight: 1, arbitrary: hotKind.chain(k => memberArb(k).map(value => ({c: 'padded' as const, kind: k, value})))},
    {weight: 2, arbitrary: fc.string({maxLength: 5}).map(text => ({c: 'text' as const, text}))},
    {weight: 2, arbitrary: hotKind.map(k => ({c: 'marked' as const, kind: k}))},
    {weight: 1, arbitrary: fc.constant({c: 'markedUnknown' as const})},
  )
  /** Content for a row that should mostly stay a value of `k`. */
  const valueContent = (k: Kind): fc.Arbitrary<ContentSpec> => fc.oneof(
    {weight: 4, arbitrary: memberArb(k).map(value => ({c: 'value' as const, kind: k, value}))},
    {weight: 1, arbitrary: content},
  )
  const pos = fc.constantFrom('first' as const, 'last' as const)
  const ownerPick = fc.nat(OWNERS.length - 1)

  const local: fc.Arbitrary<LocalOp> = fc.oneof(
    {weight: 6, arbitrary: fc.record({owner, kind: hotKind}).chain(({owner: o, kind: k}) =>
      valueArb(k).map(value => ({op: 'set' as const, owner: o, kind: k, value})))},
    {weight: 2, arbitrary: fc.record({op: fc.constant('unset' as const), owner, kind: hotKind})},
    {weight: 2, arbitrary: fc.record({
      op: fc.constant('setMany' as const),
      owner,
      sets: fc.array(hotKind.chain(k => valueArb(k).map(value => ({kind: k, value}))), {maxLength: 3}),
      unsets: fc.array(hotKind, {maxLength: 2}),
    })},
    {weight: 3, arbitrary: fc.record({
      op: fc.constant('rawBag' as const),
      owner,
      edits: fc.array(hotKind.chain(k => fc.record({
        kind: fc.constant(k), value: valueArb(k), remove: fc.boolean(),
      })), {minLength: 1, maxLength: 3}),
    })},
    {weight: 3, arbitrary: row.chain(r => fc.record({
      op: fc.constant('editContent' as const), row: fc.constant(r),
      content: r.level === 'value' ? hotKind.chain(valueContent) : content,
    }))},
    {weight: 2, arbitrary: fc.record({op: fc.constant('deleteRow' as const), row})},
    {weight: 3, arbitrary: fc.record({
      op: fc.constant('moveRow' as const), row, dest: fc.record({owner, kind: hotKind}), pos,
    })},
    {weight: 2, arbitrary: fc.record({
      op: fc.constant('addChild' as const),
      parent: fc.oneof(row, fc.record({owner})),
      content,
      pos,
    })},
    {weight: 1, arbitrary: fc.record({op: fc.constant('deleteOwner' as const), pick: ownerPick})},
    {weight: 1, arbitrary: fc.record({op: fc.constant('restoreOwner' as const), pick: ownerPick})},
  )

  const raw: fc.Arbitrary<RawOp> = fc.oneof(
    {weight: 3, arbitrary: fc.record({top: hotTop, kind: hotKind}).chain(({top: t, kind: k}) => fc.record({
      op: fc.constant('rawDupField' as const), top: fc.constant(t), kind: fc.constant(k),
      values: fc.array(valueContent(k), {maxLength: 2}),
      key: fc.constantFrom('first' as const, 'last' as const, 'tie' as const),
      peerCell: fc.boolean(),
    }))},
    {weight: 3, arbitrary: row.chain(r => fc.record({
      op: fc.constant('rawContent' as const), row: fc.constant(r),
      content: r.level === 'value' ? hotKind.chain(valueContent) : content,
      withCell: fc.boolean(),
    }))},
    {weight: 2, arbitrary: fc.record({
      op: fc.constant('rawDelete' as const), row, subtree: fc.boolean(), withCell: fc.boolean(),
    })},
    {weight: 2, arbitrary: fc.record({top: hotTop, kind: hotKind}).chain(({top: t, kind: k}) => fc.record({
      op: fc.constant('rawCell' as const), top: fc.constant(t), kind: fc.constant(k),
      value: valueArb(k), remove: fc.boolean(),
    }))},
    {weight: 1, arbitrary: fc.record({top: hotTop, kind: hotKind}).chain(({top: t, kind: k}) => fc.record({
      op: fc.constant('rawOrphan' as const), top: fc.constant(t), kind: fc.constant(k),
      content: valueContent(k),
    }))},
    {weight: 1, arbitrary: fc.record({op: fc.constant('rawDeleteOwner' as const), pick: ownerPick})},
    {weight: 1, arbitrary: fc.record({op: fc.constant('rawRestoreOwner' as const), pick: ownerPick})},
  )
  return {local, raw}
}

const txArb = (mode: Mode, focus: Focus): fc.Arbitrary<TxSpec> => {
  const {local, raw} = opArbs(focus)
  const batch: fc.Arbitrary<TxSpec> = fc.oneof(
    // Mostly one op per tx; the multi-op txs are where same-tx
    // interleavings (eager vs deferred, cell vs children) live.
    {weight: 3, arbitrary: local.map(op => ({t: 'batch' as const, ops: [op]}))},
    {weight: 2, arbitrary: fc.array(local, {minLength: 2, maxLength: 4}).map(ops => ({t: 'batch' as const, ops}))},
  )
  return mode === 'local'
    ? fc.oneof(
      {weight: 10, arbitrary: batch},
      {weight: 1, arbitrary: fc.constant({t: 'undo' as const})},
      {weight: 1, arbitrary: fc.constant({t: 'redo' as const})},
    )
    : fc.oneof(
      {weight: 7, arbitrary: batch},
      {weight: 4, arbitrary: raw.map(op => ({t: 'raw' as const, op}))},
    )
}

const caseArb = fc.record({
  mode: fc.constantFrom<Mode>('local', 'sync'),
  focus: fc.record({top: TOP_ARB, kind: KIND_ARB}),
}).chain(({mode, focus}) => fc.record({
  mode: fc.constant(mode),
  txs: fc.array(txArb(mode, focus), {minLength: 1, maxLength: 14}),
  prngSeed: fc.integer({min: 1, max: 2 ** 31 - 2}),
}))

// ──── shared db ────

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
const guard = statefulFuzzGuard()
afterAll(async () => {
  await guard.barrier()
  await sharedDb.cleanup()
})

const seedWorkspace = async (): Promise<Repo> => {
  await sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
    [WS, 'ws', 'user-1'],
  )
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  for (const kind of KINDS) {
    const {schema, fieldId} = SCHEMAS[kind]
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      `test-${schema.name}-definition`,
      [{
        metadata: {
          fieldId, workspaceId: WS, createdAt: 1, name: schema.name,
          changeScope: schema.changeScope, hidden: false, origin: 'user' as const,
        },
        schema,
      }],
      {workspaceId: WS},
    )
  }
  await repo.tx(async tx => {
    await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'root'})
    const keys = keysBetween(null, null, OWNERS.length)
    for (const [i, id] of OWNERS.entries()) {
      await tx.create({id, workspaceId: WS, parentId: ROOT, orderKey: keys[i]!, content: id})
    }
  }, {scope: ChangeScope.BlockDefault})
  repo.undoManagerFor(WS).clear()
  return repo
}

// ──── db reads ────

interface Row {
  id: string
  parent_id: string | null
  order_key: string
  content: string
  deleted: number
  is_field_form: number | null
  reference_target_id: string | null
  properties_json: string
}

interface DbState {
  byId: Map<string, Row>
  /** LIVE children per parent, in `(order_key, id)` order. */
  liveChildren: Map<string, Row[]>
}

const readState = async (): Promise<DbState> => {
  const rows = await sharedDb.db.getAll<Row>(
    `SELECT id, parent_id, order_key, content, deleted, is_field_form, reference_target_id, properties_json
       FROM blocks WHERE workspace_id = ? ORDER BY order_key, id`,
    [WS],
  )
  const byId = new Map<string, Row>()
  const liveChildren = new Map<string, Row[]>()
  for (const row of rows) {
    byId.set(row.id, row)
    if (row.deleted !== 0 || row.parent_id === null) continue
    const siblings = liveChildren.get(row.parent_id)
    if (siblings) siblings.push(row)
    else liveChildren.set(row.parent_id, [row])
  }
  return {byId, liveChildren}
}

const bagOf = (row: Row | undefined): Record<string, unknown> =>
  row === undefined ? {} : JSON.parse(row.properties_json) as Record<string, unknown>

const liveFieldRows = (state: DbState, ownerId: string, fieldId: string): Row[] =>
  (state.liveChildren.get(ownerId) ?? [])
    .filter(child => child.is_field_form === 1 && child.reference_target_id === fieldId)

/** What `ownerId`'s cell must hold for `kind`, from its live children —
 *  `undefined` for "key unset". */
const projectFromChildren = (state: DbState, ownerId: string, kind: Kind): unknown => {
  const {schema, fieldId} = SCHEMAS[kind]
  const fieldRows = liveFieldRows(state, ownerId, fieldId)
  if (fieldRows.length === 0) return undefined
  const perFieldRow = fieldRows.map(fieldRow =>
    (state.liveChildren.get(fieldRow.id) ?? []).filter(child => child.is_field_form !== 1))
  return childContentsToEncodedPropertyValue(
    schema, unionValuesAcrossFieldRows(schema, perFieldRow).map(value => value.content))
}

const sameValue = (a: unknown, b: unknown): boolean =>
  a === undefined || b === undefined ? a === b : jsonValuesEqual(a, b)

const fullSnapshot = async (): Promise<SnapRow[]> =>
  sharedDb.db.getAll<SnapRow>(
    `SELECT id, parent_id, order_key, content, properties_json, references_json, deleted,
            reference_target_id, is_field_form
       FROM blocks ORDER BY id`,
  )
type SnapRow = Record<string, unknown> & {id: string; deleted: number}

// ──── content + selection helpers ────

const contentOf = (kind: Kind, member: unknown): string => {
  const {schema} = SCHEMAS[kind]
  try {
    const encoded = schema.codec.encode(kind === 'tags' ? [member] : member)
    return encodedPropertyValueToChildContents(schema, encoded)[0] ?? ''
  } catch {
    return String(member)
  }
}

const resolveContent = (spec: ContentSpec): string => {
  switch (spec.c) {
    case 'value': return contentOf(spec.kind, spec.value)
    case 'padded': return ` ${contentOf(spec.kind, spec.value)} `
    case 'text': return spec.text
    case 'marked': return propertyFieldContent(SCHEMAS[spec.kind].fieldId)
    case 'markedUnknown': return propertyFieldContent(UNKNOWN_FIELD_ID)
  }
}
const isMarkedSpec = (spec: ContentSpec): boolean => spec.c === 'marked' || spec.c === 'markedUnknown'

const isLive = async (tx: Tx, id: string): Promise<boolean> => {
  const row = await tx.get(id)
  return row !== null && !row.deleted
}

const fieldRowsIn = async (tx: Tx, ownerId: string, kind: Kind) =>
  (await tx.childrenOf(ownerId, undefined))
    .filter(child => child.isFieldForm === true && child.referenceTargetId === SCHEMAS[kind].fieldId)

/** Live rows strictly under `rootId`, depth-first in sibling order. */
const subtreeIn = async (tx: Tx, rootId: string): Promise<BlockData[]> => {
  const out: BlockData[] = []
  const stack = [rootId]
  while (stack.length > 0) {
    const children = await tx.childrenOf(stack.pop()!, undefined)
    out.push(...children)
    for (const child of [...children].reverse()) stack.push(child.id)
  }
  return out
}

/** The rows a `RowSel` level means, in the order given: any marked row, or
 *  an unmarked child of one. Shared by the local and the raw resolvers. */
const rowsAtLevel = <R extends {id: string; parentId: string | null; marked: boolean}>(
  rows: readonly R[],
  level: RowSel['level'],
): R[] => {
  const marked = new Set(rows.filter(r => r.marked).map(r => r.id))
  return level === 'field'
    ? rows.filter(r => r.marked)
    : rows.filter(r => !r.marked && r.parentId !== null && marked.has(r.parentId))
}

const pickFrom = <T>(items: readonly T[], pick: number): T | null =>
  items.length === 0 ? null : items[pick % items.length]!

const levelRowsIn = async (tx: Tx, rootId: string, level: RowSel['level']): Promise<string[]> =>
  rowsAtLevel(
    (await subtreeIn(tx, rootId)).map(r => ({id: r.id, parentId: r.parentId, marked: r.isFieldForm === true})),
    level,
  ).map(r => r.id)

const resolveOwner = async (tx: Tx, sel: OwnerSel): Promise<string | null> => {
  const top = OWNERS[sel.top]!
  if (!(await isLive(tx, top))) return null
  if (sel.nested === undefined) return top
  return pickFrom(await levelRowsIn(tx, top, 'value'), sel.nested)
}

const resolveRow = async (tx: Tx, sel: RowSel): Promise<string | null> => {
  const root = sel.within === null ? ROOT : OWNERS[sel.within]!
  if (!(await isLive(tx, root))) return null
  return pickFrom(await levelRowsIn(tx, root, sel.level), sel.pick)
}

/** The `pick`-th top owner whose liveness is `live`. */
const pickTop = async (tx: Tx, pick: number, live: boolean): Promise<string | null> => {
  const matching: string[] = []
  for (const id of OWNERS) {
    const row = await tx.get(id)
    if (row !== null && row.deleted !== live) matching.push(id)
  }
  return pickFrom(matching, pick)
}

/** An order key at `pos` among `parentId`'s live children. */
const keyAt = async (tx: Tx, parentId: string, pos: 'first' | 'last', excludeId?: string): Promise<string> => {
  const siblings = (await tx.childrenOf(parentId, undefined)).filter(s => s.id !== excludeId)
  if (siblings.length === 0) return keysBetween(null, null, 1)[0]!
  return pos === 'first'
    ? keysBetween(null, siblings[0]!.orderKey, 1)[0]!
    : keysBetween(siblings.at(-1)!.orderKey, null, 1)[0]!
}

/** `id` and every ancestor above it. */
const lineage = async (tx: Tx, id: string): Promise<string[]> => {
  const out: string[] = []
  let cursor: string | null = id
  while (cursor !== null && out.length < 32) {
    out.push(cursor)
    cursor = (await tx.get(cursor))?.parentId ?? null
  }
  return out
}

// ──── waivers: what arrivals and tree edits are allowed to leave behind ────

interface Waivers {
  /** `${owner}|${fieldId}` whose cell an arrival left out of step with its
   *  children (the arrival path never re-projects). */
  proj: Set<string>
  /** `${owner}|${fieldId}` that may hold duplicate field rows. */
  dup: Set<string>
  /** Row ids an arrival left live under a tombstone. */
  orphans: Set<string>
}
const pairKey = (ownerId: string, fieldId: string): string => `${ownerId}|${fieldId}`
const waiveOwner = (set: Set<string>, ownerId: string): void => {
  for (const kind of KINDS) set.add(pairKey(ownerId, SCHEMAS[kind].fieldId))
}

// ──── one local transaction ────

const ABSENT = undefined
type Ev = {cls: 'E' | 'R'; value: unknown}

interface TxLog {
  /** owner → cell key → cell writes, in order. */
  events: Map<string, Map<string, Ev[]>>
  /** Owners some child edit in this tx reached (the edited rows, their
   *  ancestors, before and after a move). */
  childTouched: Set<string>
  /** Owners a child edit may have handed a NEW marked row. */
  dupRisk: Set<string>
  /** owner → keys an eager write reconciled children for. */
  eagerConverged: Map<string, Set<string>>
}

const addEvent = (log: TxLog, ownerId: string, name: string, ev: Ev): void => {
  let byName = log.events.get(ownerId)
  if (!byName) log.events.set(ownerId, byName = new Map())
  const evs = byName.get(name)
  if (evs) evs.push(ev)
  else byName.set(name, [ev])
}
const addConverged = (log: TxLog, ownerId: string, name: string): void => {
  let names = log.eagerConverged.get(ownerId)
  if (!names) log.eagerConverged.set(ownerId, names = new Set())
  names.add(name)
}
const touch = async (log: TxLog, tx: Tx, id: string): Promise<void> => {
  for (const id_ of await lineage(tx, id)) log.childTouched.add(id_)
}

const encodeFor = (kind: Kind, value: unknown): unknown => SCHEMAS[kind].schema.codec.encode(value)

const applyLocalOp = async (tx: Tx, op: LocalOp, log: TxLog): Promise<boolean> => {
  switch (op.op) {
    case 'set': {
      const owner = await resolveOwner(tx, op.owner)
      if (owner === null) return false
      const {schema} = SCHEMAS[op.kind]
      const stored = (await tx.get(owner))!.properties[schema.name]
      const encoded = encodeFor(op.kind, op.value)
      await tx.setProperty(owner, schema, op.value)
      addEvent(log, owner, schema.name, {cls: 'E', value: encoded})
      if (!sameValue(stored, encoded)) addConverged(log, owner, schema.name)
      return true
    }
    case 'unset': {
      const owner = await resolveOwner(tx, op.owner)
      if (owner === null) return false
      const {schema} = SCHEMAS[op.kind]
      const stored = (await tx.get(owner))!.properties[schema.name]
      await tx.unsetProperty(owner, schema)
      addEvent(log, owner, schema.name, {cls: 'E', value: ABSENT})
      if (stored !== undefined) addConverged(log, owner, schema.name)
      return true
    }
    case 'setMany': {
      const owner = await resolveOwner(tx, op.owner)
      if (owner === null) return false
      const before = (await tx.get(owner))!.properties
      await tx.setProperties(owner, {
        set: op.sets.map(({kind, value}) => ({schema: SCHEMAS[kind].schema, value})),
        unset: op.unsets.map(kind => SCHEMAS[kind].schema),
      })
      // Sets first, then unsets — an unset wins over a set of the same key.
      const unset = new Set(op.unsets.map(kind => SCHEMAS[kind].schema.name))
      const after = {...before}
      for (const {kind, value} of op.sets) {
        const name = SCHEMAS[kind].schema.name
        if (unset.has(name)) continue
        after[name] = encodeFor(kind, value)
        addEvent(log, owner, name, {cls: 'E', value: after[name]})
      }
      for (const name of unset) {
        delete after[name]
        addEvent(log, owner, name, {cls: 'E', value: ABSENT})
      }
      // A net no-op batch writes nothing at all; otherwise EVERY listed key
      // has its children reconciled, changed or not.
      if (!jsonValuesEqual(before, after)) {
        for (const {kind} of op.sets) addConverged(log, owner, SCHEMAS[kind].schema.name)
        for (const name of unset) addConverged(log, owner, name)
      }
      return true
    }
    case 'rawBag': {
      const owner = await resolveOwner(tx, op.owner)
      if (owner === null) return false
      const bag = {...(await tx.get(owner))!.properties}
      for (const {kind, value, remove} of op.edits) {
        const name = SCHEMAS[kind].schema.name
        if (remove) delete bag[name]
        else bag[name] = encodeFor(kind, value)
        addEvent(log, owner, name, {cls: 'R', value: remove ? ABSENT : bag[name]})
      }
      await tx.update(owner, {properties: bag})
      return true
    }
    case 'editContent': {
      const id = await resolveRow(tx, op.row)
      if (id === null) return false
      await touch(log, tx, id)
      if (isMarkedSpec(op.content)) log.dupRisk.add((await tx.get(id))!.parentId!)
      await tx.update(id, {content: resolveContent(op.content)})
      return true
    }
    case 'deleteRow': {
      const id = await resolveRow(tx, op.row)
      if (id === null) return false
      await touch(log, tx, id)
      await deleteSubtreeInTx(tx, id)
      return true
    }
    case 'moveRow': {
      const id = await resolveRow(tx, op.row)
      if (id === null) return false
      const destOwner = await resolveOwner(tx, op.dest.owner)
      if (destOwner === null) return false
      const destParent = (await fieldRowsIn(tx, destOwner, op.dest.kind))[0]?.id ?? destOwner
      await touch(log, tx, id)
      await touch(log, tx, destParent)
      log.dupRisk.add(destParent)
      await tx.move(id, {parentId: destParent, orderKey: await keyAt(tx, destParent, op.pos, id)})
      return true
    }
    case 'addChild': {
      const parent = 'owner' in op.parent
        ? await resolveOwner(tx, op.parent.owner)
        : await resolveRow(tx, op.parent)
      if (parent === null) return false
      await touch(log, tx, parent)
      if (isMarkedSpec(op.content)) log.dupRisk.add(parent)
      await tx.create({
        workspaceId: WS, parentId: parent,
        orderKey: await keyAt(tx, parent, op.pos),
        content: resolveContent(op.content),
      })
      return true
    }
    case 'deleteOwner': {
      const owner = await pickTop(tx, op.pick, true)
      if (owner === null) return false
      await deleteSubtreeInTx(tx, owner)
      return true
    }
    case 'restoreOwner': {
      const owner = await pickTop(tx, op.pick, false)
      if (owner === null) return false
      await tx.restore(owner)
      return true
    }
  }
}

/** Legal outcomes for a tx built from blind ops: the kernel's typed
 *  rejections (a move into a descendant, a tombstoned parent, …), and
 *  MATERIALIZE refusing a cell value no value child can carry
 *  (`undecodableCellValueError`) — a string that does not survive the
 *  content round trip reaches it through either cell writer. */
const assertLegalRejection = (e: unknown, desc: string): void => {
  if (e instanceof Error && e.message.startsWith('Cannot materialize property')) return
  assertLegalKernelRejection(e, desc)
}

// ──── raw (sync-shaped) writes ────

type Lock = Parameters<Parameters<TestDb['db']['writeTransaction']>[0]>[0]
let rawSeq = 0

const derivedColumns = async (content: string): Promise<{target: string | null; isFieldForm: number | null}> => {
  const derived = await deriveReferenceColumns(content, WS, {aliasTargetId: async () => null})
  return {target: derived.targetId ?? null, isFieldForm: derived.isFieldForm ? 1 : null}
}

/** Inserts one peer row. A MARKED row makes its parent an owner whose cell
 *  the arrival never wrote, so that parent's pairs are waived. */
const rawInsert = async (
  lock: Lock, waivers: Waivers, parentId: string, orderKey: string, content: string,
): Promise<string> => {
  const id = `peer-${++rawSeq}`
  const {target, isFieldForm} = await derivedColumns(content)
  if (isFieldForm === 1) {
    waiveOwner(waivers.proj, parentId)
    waiveOwner(waivers.dup, parentId)
  }
  await lock.execute(
    `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json, references_json,
                         created_at, updated_at, created_by, updated_by, deleted, reference_target_id, is_field_form)
     VALUES (?, ?, ?, ?, ?, '{}', '[]', 1, 1, 'peer', 'peer', 0, ?, ?)`,
    [id, WS, parentId, orderKey, content, target, isFieldForm],
  )
  return id
}

const rawSetCell = async (lock: Lock, ownerId: string, name: string, value: unknown): Promise<void> => {
  const row = await lock.get<{properties_json: string}>('SELECT properties_json FROM blocks WHERE id = ?', [ownerId])
  const bag = JSON.parse(row.properties_json) as Record<string, unknown>
  if (value === undefined) delete bag[name]
  else bag[name] = value
  await lock.execute('UPDATE blocks SET properties_json = ?, updated_at = updated_at + 1 WHERE id = ?',
    [JSON.stringify(bag), ownerId])
}

/** A peer's PROJECT for one owner: rewrite its cell from its children. */
const rawReproject = async (lock: Lock, ownerId: string): Promise<void> => {
  const state = await readStateIn(lock)
  const owner = state.byId.get(ownerId)
  if (owner === undefined || owner.deleted) return
  for (const kind of KINDS) {
    await rawSetCell(lock, ownerId, SCHEMAS[kind].schema.name, projectFromChildren(state, ownerId, kind))
  }
}

const readStateIn = async (lock: Lock): Promise<DbState> => {
  const rows = await lock.getAll<Row>(
    `SELECT id, parent_id, order_key, content, deleted, is_field_form, reference_target_id, properties_json
       FROM blocks WHERE workspace_id = ? ORDER BY order_key, id`,
    [WS],
  )
  const byId = new Map<string, Row>()
  const liveChildren = new Map<string, Row[]>()
  for (const row of rows) {
    byId.set(row.id, row)
    if (row.deleted !== 0 || row.parent_id === null) continue
    const siblings = liveChildren.get(row.parent_id)
    if (siblings) siblings.push(row)
    else liveChildren.set(row.parent_id, [row])
  }
  return {byId, liveChildren}
}

const rawRowOf = (state: DbState, sel: RowSel): Row | null => {
  const root = state.byId.get(sel.within === null ? ROOT : OWNERS[sel.within]!)
  if (root === undefined || root.deleted !== 0) return null
  const rows: Row[] = []
  const stack = [root.id]
  while (stack.length > 0) {
    const children = state.liveChildren.get(stack.pop()!) ?? []
    rows.push(...children)
    for (const child of [...children].reverse()) stack.push(child.id)
  }
  const picked = pickFrom(rowsAtLevel(
    rows.map(r => ({id: r.id, parentId: r.parent_id, marked: r.is_field_form === 1})), sel.level), sel.pick)
  return picked === null ? null : state.byId.get(picked.id)!
}

const rawPickTop = (state: DbState, pick: number, live: boolean): string | null =>
  pickFrom(OWNERS.filter(id => (state.byId.get(id)!.deleted === 0) === live), pick)

const subtreeIds = (state: DbState, rootId: string): string[] => {
  const out: string[] = []
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()!
    out.push(id)
    for (const row of state.byId.values()) if (row.parent_id === id) stack.push(row.id)
  }
  return out
}

const applyRawOp = async (op: RawOp, waivers: Waivers): Promise<void> => {
  await sharedDb.db.writeTransaction(async lock => {
    const state = await readStateIn(lock)
    switch (op.op) {
      case 'rawDupField': {
        // A peer that minted its own field row for the same property.
        const ownerId = OWNERS[op.top]!
        const owner = state.byId.get(ownerId)!
        if (owner.deleted) return
        const {fieldId, schema} = SCHEMAS[op.kind]
        const siblings = state.liveChildren.get(ownerId) ?? []
        const existing = liveFieldRows(state, ownerId, fieldId)
        const orderKey = op.key === 'tie' && existing.length > 0
          ? existing[0]!.order_key
          : op.key === 'first' && siblings.length > 0
            ? keysBetween(null, siblings[0]!.order_key, 1)[0]!
            : keysBetween(siblings.at(-1)?.order_key ?? null, null, 1)[0]!
        const fieldRowId = await rawInsert(lock, waivers, ownerId, orderKey, propertyFieldContent(fieldId))
        const contents = op.values.map(resolveContent)
        const keys = keysBetween(null, null, Math.max(contents.length, 1))
        for (const [i, content] of contents.entries()) await rawInsert(lock, waivers, fieldRowId, keys[i]!, content)
        if (op.peerCell) {
          // The peer's own cell: what ITS children project to, alone.
          await rawSetCell(lock, ownerId, schema.name, childContentsToEncodedPropertyValue(schema, contents))
        }
        waivers.proj.add(pairKey(ownerId, fieldId))
        waivers.dup.add(pairKey(ownerId, fieldId))
        return
      }
      case 'rawContent': {
        const row = rawRowOf(state, op.row)
        if (row === null) return
        const content = resolveContent(op.content)
        const {target, isFieldForm} = await derivedColumns(content)
        await lock.execute(
          `UPDATE blocks SET content = ?, reference_target_id = ?, is_field_form = ?, updated_at = updated_at + 1
            WHERE id = ?`,
          [content, target, isFieldForm, row.id],
        )
        const affected = [row.parent_id!, state.byId.get(row.parent_id!)?.parent_id ?? null]
          .filter((id): id is string => id !== null)
        if (isFieldForm === 1) waiveOwner(waivers.dup, row.parent_id!)
        for (const ownerId of affected) {
          if (op.withCell) await rawReproject(lock, ownerId)
          else waiveOwner(waivers.proj, ownerId)
        }
        return
      }
      case 'rawDelete': {
        const row = rawRowOf(state, op.row)
        if (row === null) return
        const ids = op.subtree ? subtreeIds(state, row.id) : [row.id]
        for (const id of ids) await lock.execute('UPDATE blocks SET deleted = 1, updated_at = updated_at + 1 WHERE id = ?', [id])
        if (!op.subtree) {
          for (const child of state.liveChildren.get(row.id) ?? []) waivers.orphans.add(child.id)
        }
        const affected = [row.parent_id!, state.byId.get(row.parent_id!)?.parent_id ?? null]
          .filter((id): id is string => id !== null)
        for (const ownerId of affected) {
          if (op.withCell) await rawReproject(lock, ownerId)
          else waiveOwner(waivers.proj, ownerId)
        }
        return
      }
      case 'rawCell': {
        const ownerId = OWNERS[op.top]!
        const {schema, fieldId} = SCHEMAS[op.kind]
        await rawSetCell(lock, ownerId, schema.name, op.remove ? undefined : encodeFor(op.kind, op.value))
        waivers.proj.add(pairKey(ownerId, fieldId))
        return
      }
      case 'rawOrphan': {
        // A peer's value written under a field row that is tombstoned here,
        // or a field row under an owner that is tombstoned here.
        const ownerId = OWNERS[op.top]!
        const {fieldId} = SCHEMAS[op.kind]
        const owner = state.byId.get(ownerId)!
        const deadFieldRow = [...state.byId.values()].find(r =>
          r.parent_id === ownerId && r.deleted === 1 && r.is_field_form === 1 && r.reference_target_id === fieldId)
        if (owner.deleted) {
          const fieldRowId = await rawInsert(lock, waivers, ownerId, keysBetween(null, null, 1)[0]!, propertyFieldContent(fieldId))
          waivers.orphans.add(fieldRowId)
          waivers.orphans.add(await rawInsert(lock, waivers, fieldRowId, keysBetween(null, null, 1)[0]!, resolveContent(op.content)))
          waiveOwner(waivers.proj, ownerId)
          waiveOwner(waivers.dup, ownerId)
        } else if (deadFieldRow) {
          waivers.orphans.add(await rawInsert(lock, waivers, deadFieldRow.id, keysBetween(null, null, 1)[0]!, resolveContent(op.content)))
        }
        return
      }
      case 'rawDeleteOwner': {
        // A peer's subtree delete, arriving whole.
        const ownerId = rawPickTop(state, op.pick, true)
        if (ownerId === null) return
        for (const id of subtreeIds(state, ownerId)) {
          await lock.execute('UPDATE blocks SET deleted = 1, updated_at = updated_at + 1 WHERE id = ? AND deleted = 0', [id])
        }
        return
      }
      case 'rawRestoreOwner': {
        // A peer's restore of the owner, arriving ahead of the field rows its
        // revival wrote.
        const ownerId = rawPickTop(state, op.pick, false)
        if (ownerId === null) return
        await lock.execute('UPDATE blocks SET deleted = 0, updated_at = updated_at + 1 WHERE id = ?', [ownerId])
        waiveOwner(waivers.proj, ownerId)
        return
      }
    }
  })
}

// ──── non-vacuity bookkeeping (read by the canary at the bottom) ────

const stats = {
  applied: new Map<string, number>(),
  skipped: new Map<string, number>(),
  raw: new Map<string, number>(),
  committed: 0,
  rejected: 0,
  intentChecked: 0,
  orderBlind: 0,
  rematerialized: 0,
  dupObserved: 0,
  projectedPresent: 0,
  restoredKeysChecked: 0,
}
const bump = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}
const resetStats = (): void => {
  for (const counts of [stats.applied, stats.skipped, stats.raw]) counts.clear()
  stats.committed = stats.rejected = stats.intentChecked = stats.orderBlind = 0
  stats.rematerialized = stats.dupObserved = stats.projectedPresent = stats.restoredKeysChecked = 0
}

// ──── oracles ────

/** P, D, O over the whole workspace, then Q. */
const checkState = async (
  repo: Repo,
  waivers: Waivers,
  rematerialize: ReadonlyMap<string, ReadonlySet<string>>,
  label: string,
): Promise<void> => {
  const state = await readState()

  for (const row of state.byId.values()) {
    if (row.deleted !== 0 || row.parent_id === null) continue
    const parent = state.byId.get(row.parent_id)
    if ((parent === undefined || parent.deleted !== 0) && !waivers.orphans.has(row.id)) {
      expect.fail(`${label}: O — live ${row.id} under ${parent === undefined ? 'missing' : 'tombstoned'} parent ${row.parent_id}`)
    }
  }

  const projectRows: ProjectableRow[] = []
  for (const owner of state.byId.values()) {
    if (owner.deleted !== 0) continue
    const bag = bagOf(owner)
    for (const kind of KINDS) {
      const {schema, fieldId} = SCHEMAS[kind]
      const key = pairKey(owner.id, fieldId)
      const fieldRows = liveFieldRows(state, owner.id, fieldId)
      if (fieldRows.length > 1) stats.dupObserved++
      if (fieldRows.length > 1 && !waivers.dup.has(key)) {
        expect.fail(`${label}: D — ${owner.id} has ${fieldRows.length} live field rows for "${schema.name}": ${fieldRows.map(r => r.id).join(', ')}`)
      }
      if (waivers.proj.has(key)) continue
      const projected = projectFromChildren(state, owner.id, kind)
      if (projected !== undefined) stats.projectedPresent++
      if (!sameValue(bag[schema.name], projected)) {
        expect.fail(`${label}: P — ${owner.id}.${schema.name}: cell ${JSON.stringify(bag[schema.name])} ≠ children ${JSON.stringify(projected)}`)
      }
      for (const fieldRow of fieldRows) {
        projectRows.push({
          id: fieldRow.id, parentId: owner.id, workspaceId: WS,
          referenceTargetId: fieldId, isFieldForm: true,
        })
      }
    }
  }

  const before = await fullSnapshot()
  await repo.tx(async tx => {
    for (const [ownerId, names] of rematerialize) {
      const owner = await tx.get(ownerId)
      if (owner === null || owner.deleted) continue
      stats.rematerialized += names.size
      await materializePropertyChildrenForExistingRow(tx, owner, lookups, [...names])
    }
    await reprojectOwnersForRowStates(tx, projectRows, lookups, 'full')
  }, {scope: ChangeScope.BlockDefault})
  expect(await fullSnapshot(), `${label}: Q — re-running MATERIALIZE/PROJECT must write nothing`).toEqual(before)
}

/** I — the cell ends where the tx's cell writes put it. */
const checkIntent = (
  log: TxLog,
  start: DbState,
  end: DbState,
  waivers: Waivers,
  label: string,
): void => {
  const startBags = new Map([...start.byId.values()].map(row => [row.id, bagOf(row)]))
  for (const owner of end.byId.values()) {
    if (owner.deleted !== 0 || start.byId.get(owner.id)?.deleted !== 1) continue
    if (log.childTouched.has(owner.id)) continue
    const written = log.events.get(owner.id)
    for (const kind of KINDS) {
      const {schema, fieldId} = SCHEMAS[kind]
      if (written?.has(schema.name) || waivers.proj.has(pairKey(owner.id, fieldId))) continue
      stats.restoredKeysChecked++
      const before = startBags.get(owner.id)?.[schema.name]
      if (!sameValue(bagOf(owner)[schema.name], before)) {
        expect.fail(`${label}: I — restoring ${owner.id} changed untouched ${schema.name}: ${JSON.stringify(before)} → ${JSON.stringify(bagOf(owner)[schema.name])}`)
      }
    }
  }
  for (const [ownerId, byName] of log.events) {
    if (log.childTouched.has(ownerId)) continue
    const owner = end.byId.get(ownerId)
    if (owner === undefined || owner.deleted !== 0) continue
    const bag = bagOf(owner)
    for (const [name, evs] of byName) {
      const actual = bag[name]
      const orderBlind = evs.some((ev, i) => ev.cls === 'E' && evs.slice(i + 1).some(later => later.cls === 'R'))
      stats.intentChecked++
      if (orderBlind) {
        stats.orderBlind++
        const candidates = [startBags.get(ownerId)?.[name], ...evs.map(ev => ev.value)]
        if (!candidates.some(c => sameValue(c, actual))) {
          expect.fail(`${label}: I — ${ownerId}.${name} = ${JSON.stringify(actual)}, none of the values written in this tx`)
        }
      } else if (!sameValue(actual, evs.at(-1)!.value)) {
        expect.fail(`${label}: I — ${ownerId}.${name} = ${JSON.stringify(actual)}, last write was ${JSON.stringify(evs.at(-1)!.value)}`)
      }
    }
  }
}

/** Pairs that currently hold duplicate field rows — what undo/redo may
 *  legitimately bring back, since it replays a state that already passed D
 *  under the waivers of its time. */
const currentDupPairs = async (): Promise<string[]> => {
  const state = await readState()
  const out: string[] = []
  for (const owner of state.byId.values()) {
    if (owner.deleted !== 0) continue
    for (const kind of KINDS) {
      const {fieldId} = SCHEMAS[kind]
      if (liveFieldRows(state, owner.id, fieldId).length > 1) out.push(pairKey(owner.id, fieldId))
    }
  }
  return out
}

const runBatch = async (repo: Repo, ops: LocalOp[], waivers: Waivers, label: string): Promise<void> => {
  const start = await readState()
  const startSnapshot = await fullSnapshot()
  const startBags = new Map([...start.byId.values()].map(row => [row.id, bagOf(row)]))
  const log: TxLog = {events: new Map(), childTouched: new Set(), dupRisk: new Set(), eagerConverged: new Map()}
  try {
    await repo.tx(async tx => {
      for (const op of ops) bump(await applyLocalOp(tx, op, log) ? stats.applied : stats.skipped, op.op)
    }, {scope: ChangeScope.BlockDefault})
    stats.committed++
  } catch (e) {
    stats.rejected++
    assertLegalRejection(e, `${label} ${JSON.stringify(ops)}`)
    expect(await fullSnapshot(), `${label}: A — a rejected tx must leave no trace`).toEqual(startSnapshot)
    await checkState(repo, waivers, new Map(), label)
    return
  }

  const end = await readState()
  checkIntent(log, start, end, waivers, label)

  for (const ownerId of log.dupRisk) waiveOwner(waivers.dup, ownerId)
  // A cell write that reached the children converges its pair — it folds
  // duplicate field rows and rewrites the children from the cell — unless a
  // child edit in the same tx could have handed the owner a row the write
  // never saw (a marked row's bit is only stamped at the end of the tx).
  const converged = new Map<string, Set<string>>()
  for (const [ownerId, byName] of log.events) {
    if (log.childTouched.has(ownerId)) continue
    const owner = end.byId.get(ownerId)
    if (owner === undefined || owner.deleted !== 0) continue
    for (const [name, evs] of byName) {
      const eager = log.eagerConverged.get(ownerId)?.has(name) === true
      // A raw bag write reaches the children only through MATERIALIZE's net
      // diff, so it converges only when the tx's final cell moved.
      const raw = evs.some(ev => ev.cls === 'R') && !sameValue(startBags.get(ownerId)?.[name], bagOf(owner)[name])
      if (!eager && !raw) continue
      let names = converged.get(ownerId)
      if (!names) converged.set(ownerId, names = new Set())
      names.add(name)
      const fieldId = lookups.resolveNameSchema(name)!.fieldId
      waivers.proj.delete(pairKey(ownerId, fieldId))
      waivers.dup.delete(pairKey(ownerId, fieldId))
    }
  }
  await checkState(repo, waivers, converged, label)
}

const runCase = async ({mode, txs}: {mode: Mode; txs: TxSpec[]}): Promise<void> => {
  await resetTestDb(sharedDb.db)
  rawSeq = 0
  const repo = await seedWorkspace()
  const seedRows = await fullSnapshot()
  const waivers: Waivers = {proj: new Set(), dup: new Set(), orphans: new Set()}
  let ranUndoRedo = false

  for (const [i, spec] of txs.entries()) {
    const label = `tx ${i} (${spec.t})`
    switch (spec.t) {
      case 'batch':
        await runBatch(repo, spec.ops, waivers, label)
        break
      case 'undo':
      case 'redo':
        ranUndoRedo = true
        await (spec.t === 'undo' ? repo.undo() : repo.redo())
        for (const key of await currentDupPairs()) waivers.dup.add(key)
        await checkState(repo, waivers, new Map(), label)
        break
      case 'raw':
        bump(stats.raw, spec.op.op)
        await applyRawOp(spec.op, waivers)
        await checkState(repo, waivers, new Map(), `${label} ${spec.op.op}`)
        break
    }
  }

  if (mode !== 'local') return
  // U — the whole sequence unwinds and replays.
  const finalSnapshot = await fullSnapshot()
  await drain(() => repo.undo())
  const undone = new Map((await fullSnapshot()).map(row => [row.id, row]))
  for (const seed of seedRows) {
    expect(undone.get(seed.id), `U — undo-all restores seed row ${seed.id}`).toEqual(seed)
  }
  for (const row of undone.values()) {
    if (seedRows.some(seed => seed.id === row.id)) continue
    expect(row.deleted, `U — ${row.id}, created during the sequence, is tombstoned by undo-all`).toBe(1)
  }
  await drain(() => repo.redo())
  if (!ranUndoRedo) {
    expect(await fullSnapshot(), 'U — redo-all returns to the final state').toEqual(finalSnapshot)
  }
  await checkState(repo, {proj: new Set(), dup: new Set(await currentDupPairs()), orphans: new Set()}, new Map(), 'after redo-all')
}

describe('properties-as-blocks dual representation under mixed writer sequences', () => {
  it('cell and children agree after every tx; cell writes land; processors stay quiescent', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, ({mode, txs, prngSeed}) =>
        guard.run(prngSeed, () => runCase({mode, txs}))),
      fuzzParams(12),
    )
  }, fuzzTestTimeout())

  // Non-vacuity canary (docs/fuzzing.md §8): every op is resolved against
  // whatever rows exist when it runs, so a generator drift that left, say,
  // value-row edits with nothing to target would keep the property green
  // while testing nothing. A fixed sample, independent of the deep-tier env.
  it('reaches every writer and every oracle', async () => {
    await guard.barrier()
    resetStats()
    await fc.assert(
      fc.asyncProperty(caseArb, ({mode, txs, prngSeed}) =>
        guard.run(prngSeed, () => runCase({mode, txs}))),
      {numRuns: 40, seed: 430},
    )
    const summary = JSON.stringify(stats, (_, v: unknown) => v instanceof Map ? Object.fromEntries(v) : v)
    for (const op of LOCAL_OPS) {
      expect(stats.applied.get(op) ?? 0, `local op "${op}" applied — ${summary}`).toBeGreaterThan(0)
    }
    for (const op of RAW_OPS) {
      expect(stats.raw.get(op) ?? 0, `raw op "${op}" ran — ${summary}`).toBeGreaterThan(0)
    }
    expect(stats.committed, 'committed txs').toBeGreaterThan(0)
    expect(stats.intentChecked, 'I checks').toBeGreaterThan(0)
    expect(stats.orderBlind, 'I order-blind carve-out reached').toBeGreaterThan(0)
    expect(stats.rematerialized, 'Q MATERIALIZE re-runs').toBeGreaterThan(0)
    expect(stats.projectedPresent, 'P compared a present value').toBeGreaterThan(0)
    expect(stats.dupObserved, 'D saw a duplicate field row').toBeGreaterThan(0)
    expect(stats.restoredKeysChecked, 'I checked a restored owner').toBeGreaterThan(0)
  }, 60_000)
})
