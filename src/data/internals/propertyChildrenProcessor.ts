/**
 * Property-children convergence processors (docs/properties-as-blocks-migration.html §5).
 * Both are PERMANENT machinery, not migration scaffolding,
 * and both are gated on the workspace flip column
 * (`workspaces.properties_migration` at or past 'children') — in an
 * un-flipped workspace neither recognizes nor writes anything (dormant).
 *
 *   core.projectPropertyChildren (children → cell): watches structural /
 *   content changes to field and value rows and rebuilds the affected
 *   parents' `properties_json` keys from their value children. This keeps
 *   manual tree edits of field/value rows convergent with the cell — and
 *   under §5's merge semantics the children are the ONLY property truth
 *   that crosses sync; the cell is a local read surface.
 *
 *   core.materializePropertyChildren (cell → children): watches
 *   `properties` and find-or-creates field/value children for changed keys.
 *   This is the convergence path for raw cell writes (importers, plugins,
 *   `tx.update({properties})`) — NOT for sync arrivals (those never pass
 *   through repo.tx; slice C's arrival reconcile re-projects from children
 *   instead, per the §5 one-direction rule).
 *
 * WHY THE PAIR DOESN'T PING-PONG (§5 callout — load-bearing invariants; a
 * refactor that breaks either turns the pair into a loop or a divergence
 * engine):
 *   1. IDEMPOTENCE — every write here is skipped when output already equals
 *      input (content compares, `propertiesEqual` short-circuit), so a
 *      dual-write's round-trip through both processors is a no-op.
 *   2. DETERMINISTIC DUPLICATE RESOLUTION — survivors are picked by
 *      `ORDER BY order_key, id`, so every replica collapses duplicates to
 *      the same rows.
 * KNOWN single-pass wrinkle (accepted): within ONE tx, `setProperty` then a
 * raw bag write that removes the same key nets to "no cell change" for
 * MATERIALIZE (net-diff semantics), so the dual-write's children survive
 * and PROJECT restores the key over the raw writer's final bag — mixed
 * setProperty+raw shapes in one tx are order-blind. Split the writes across
 * txs for last-write-wins semantics.
 *
 * Also load-bearing (§5): a cell key with NO child rows at all is pending
 * materialization for the projection direction — reprojection only rebuilds
 * keys whose (parent, fieldId) was actually touched by a child change, and
 * the materialize direction is what creates children; absent children never
 * license deleting a cell key here.
 */

import {
  defineSameTxProcessor,
  memberCodecOf,
  type AnyPropertySchema,
  type BlockData,
  type ResolvedPropertySchema,
  type SameTxCtx,
  type Tx,
} from '@/data/api'
import { keyAtStart, keysBetween } from '@/data/orderKey'
import {
  childContentsToEncodedPropertyValue,
  encodedPropertyValueToChildContents,
  getPropertyFieldTargetId,
  fieldValueChildren,
  isFieldValueChild,
  memberKeysFor,
  propertiesEqual,
  propertyCellValueRejection,
  propertyFieldContent,
  unionValuesAcrossFieldRows,
} from '@/data/propertyChildren'
import { jsonValuesEqual } from './jsonCanonical'
import { deleteSubtreeInTx } from '@/data/subtreeDelete'

export const MATERIALIZE_PROPERTY_CHILDREN_PROCESSOR_NAME = 'core.materializePropertyChildren'
export const PROJECT_PROPERTY_CHILDREN_PROCESSOR_NAME = 'core.projectPropertyChildren'

/** fieldId → the schema the projection uses. Winners only: shadowed losers
 *  stay fieldId-recognizable at READ sites (§6) but are excluded from the
 *  name map and the cell projection, so here they resolve to undefined. */
type ResolveFieldSchema = (fieldId: string) => AnyPropertySchema | undefined
/** name → schema for the materialize direction (cell keys are name-keyed). */
type ResolveNameSchema = (name: string) => (AnyPropertySchema & {fieldId: string}) | undefined

interface PropertyChildrenLookups {
  resolveFieldSchema: ResolveFieldSchema
  resolveNameSchema: ResolveNameSchema
}

/** The projection direction's lookup half, on its own: raw repair paths
 *  (`Repo.stampReferenceTargets`) re-project owner cells without a
 *  materialize direction to feed. */
export type ProjectionLookups = Pick<PropertyChildrenLookups, 'resolveFieldSchema'>

/** The materialize direction's half. Cell keys are name-keyed, so this
 *  direction never resolves a fieldId — which lets a caller that already
 *  knows which schemas it is materializing supply just those, instead of a
 *  whole workspace resolver (`mergeBlocksInTx`'s pre-backfill catch-up). */
export type MaterializeLookups = Pick<PropertyChildrenLookups, 'resolveNameSchema'>

/** The fields the projection direction reads off a changed row. Narrower
 *  than `BlockData` so a repair path can retain a few columns per stamped
 *  row instead of whole rows (bags + references) across a workspace scan. */
export type ProjectableRow =
  Pick<BlockData, 'id' | 'parentId' | 'workspaceId' | 'referenceTargetId' | 'isFieldForm'>

/**
 * `full` — the projection is authoritative: children are truth, so a field
 * set with no parseable value UNSETS the owner's key (§9's default-value
 * rule). Only correct inside `core.projectPropertyChildren`, whose
 * `settledWrites` stops the follow-on materialize reading that unset as a
 * user deleting the key.
 *
 * `additive` — the caller did not observe user intent and its write is NOT
 * settled, so it may only GIVE an owner a key it lacks. Never unset, never
 * overwrite. This is the raw-stamp repair path: for the whole window between
 * a workspace flipping and its backfill landing, every owner holds cell keys
 * with no field rows at all, and a `full` re-projection there would read
 * "nothing parses" as "unset" and drive materialize into tombstoning the
 * very rows it just recognized.
 */
export type ProjectionMode = 'full' | 'additive'

const lookupsFor = (ctx: SameTxCtx, workspaceId: string): PropertyChildrenLookups => ({
  resolveFieldSchema: (fieldId) => {
    const resolution = ctx.resolvePropertySchemaField(workspaceId, fieldId)
    return resolution.status === 'resolved' ? resolution.schema : undefined
  },
  resolveNameSchema: (name) => {
    const resolution = ctx.resolvePropertySchemaName(workspaceId, name)
    return resolution.status === 'resolved'
      ? resolution.schema as ResolvedPropertySchema<unknown>
      : undefined
  },
})

// ─── children → cell (project) ───────────────────────────────────────────

/** Owner id → the fields on that owner this pass must re-project, each carrying
 *  the schema resolution that admitted it. Grouped by OWNER because every read
 *  and the write below are per-owner: an owner with *k* touched properties
 *  costs one `get` + one `childrenOf` + one `update`, not *k* of each. The
 *  `setProperties` fan-out and the one-time cell→children pass both hit this
 *  with several fields on one row. */
type AffectedOwners = Map<string, Map<string, AnyPropertySchema>>

const addAffectedProjection = (
  out: AffectedOwners,
  parentId: string | null,
  fieldId: string | undefined,
  lookups: ProjectionLookups,
): void => {
  if (parentId === null) return
  if (fieldId === undefined) return
  // Resolved ONCE, here, and carried: this is the gate that admits a field at
  // all, so a re-resolve downstream is both a second lookup and a branch
  // nothing can reach.
  const schema = lookups.resolveFieldSchema(fieldId)
  if (!schema) return
  let fields = out.get(parentId)
  if (fields === undefined) {
    fields = new Map()
    out.set(parentId, fields)
  }
  fields.set(fieldId, schema)
}

/** Reads a parent row at most once per collection pass. The processor path
 *  feeds the pass the before AND after of every changed row, and both sides of
 *  one change share a parent, so the repeat is that path's ordinary case rather
 *  than an edge one; a caller that passes a single row state (the stamp repair)
 *  simply never hits the memo. Only sound while nothing writes — see its
 *  construction in {@link reprojectOwnersForRowStates}. */
type ParentReader = (id: string) => Promise<BlockData | null>

/** Walk up at most two levels from a changed row to the (parent, fieldId)
 *  pairs it can affect: the row as a field row (parent = owning block), and
 *  the row as a value child (parent = field row → owning block). Both the
 *  before and after sides of a move are collected by the caller. */
const collectAffectedProjection = async (
  out: AffectedOwners,
  row: ProjectableRow | null,
  lookups: ProjectionLookups,
  readParent: ParentReader,
): Promise<void> => {
  if (row === null) return
  // The row as a FIELD ROW (parent = owning block): §9 selection keys on
  // the bit — an unmarked ref row is never a field row. The before side of
  // a bit change carries its own snapshot's bit, so a row that just left
  // the marked form still re-projects (drops) its old key.
  if (row.isFieldForm === true) {
    addAffectedProjection(out, row.parentId, getPropertyFieldTargetId(row), lookups)
  }

  if (row.parentId === null) return
  const parent = await readParent(row.parentId)
  if (parent === null || parent.parentId === null) return
  // The row as a VALUE child (parent = field row → owning block): only a
  // marked parent is a field row, and only a non-marked row is its value.
  if (parent.isFieldForm === true && isFieldValueChild(row)) {
    addAffectedProjection(out, parent.parentId, getPropertyFieldTargetId(parent), lookups)
  }
}

/** The value a schema's field rows project onto their owner's cell, in
 *  deterministic `(order_key, id)` order — `undefined` when nothing parses,
 *  which §9 reads as "key unset" while the rows stay visible and fixable in
 *  the tree. Single-valued takes the first parseable value; multi-valued
 *  AGGREGATES the members (`childContentsToEncodedPropertyValue` owns both
 *  rules, and the dedupe that makes divergence and multiplicity one shape).
 *
 *  Across ALL of a schema's field rows, not just the first: duplicate field
 *  rows are a transient conflict that `collapseDuplicateFieldRow` resolves by
 *  making one row's values PEERS of the other's, so reading only one would
 *  drop members that are about to become siblings anyway.
 *
 *  Denoted-value rule (§5): only DIRECT value children are read — a
 *  comment deep under a value child never re-projects the parent. */
const projectedFieldValue = async (
  tx: Tx,
  schema: AnyPropertySchema,
  fieldRows: readonly BlockData[],
): Promise<unknown | undefined> => {
  // NO field row at all: the key is unset. That is the only thing that unsets a
  // multi-valued property, and it is the precondition
  // `childContentsToEncodedPropertyValue` is documented to be called under —
  // it answers `[]` for a live field row with nothing parseable under it.
  if (fieldRows.length === 0) return undefined
  // §9 value set: `is_field_form IS NOT 1` children only — a nested marked row
  // materialized under the field row is its own machinery, never a value
  // candidate. `unionValuesAcrossFieldRows` owns what happens across the rows.
  const perFieldRow: BlockData[][] = []
  for (const fieldRow of fieldRows) {
    perFieldRow.push(await fieldValueChildren(tx, fieldRow.id))
  }
  return childContentsToEncodedPropertyValue(
    schema, unionValuesAcrossFieldRows(schema, perFieldRow).map(value => value.content))
}

// §9 selection: the bit + target pair (the JS twin of
// SELECT_PROPERTY_FIELD_CHILD_SQL) — without the bit an unmarked
// `((fieldId))` link row would be selected as the field row.
const fieldRowsForSchema = (
  children: readonly BlockData[],
  fieldId: string,
): BlockData[] => children.filter(child =>
  child.isFieldForm === true && getPropertyFieldTargetId(child) === fieldId)

/** Re-project ONE owner's cell for every field of it this pass touched.
 *
 *  The `childrenOf` read is hoisted out of the field loop because it is
 *  invariant across it: the only write here is the owner's OWN cell, which
 *  changes no child, and post-commit processors cannot run mid-tx. */
const reprojectOwner = async (
  tx: Tx,
  parentId: string,
  fields: ReadonlyMap<string, AnyPropertySchema>,
  mode: ProjectionMode,
): Promise<void> => {
  const parent = await tx.get(parentId)
  if (parent === null || parent.deleted) return
  // No interior gate (§9 flat recognition): ANY block — value rows and
  // field rows included — hosts field rows via its `::` children, and its
  // cell projects from them like every other owner's. The old hazard (a
  // ref-typed value misread as a field row of its parent) is structurally
  // gone: unmarked rows never classify.
  const children = await tx.childrenOf(parentId, undefined)
  const nextProperties = {...parent.properties}
  // Both additive checks are PER FIELD, never hoisted to the owner: they ask
  // about one property name and one property's field rows.
  for (const [fieldId, schema] of fields) {
    // Additive mode stops at a key the owner already holds — BEFORE the value
    // scan, since the answer can't change the outcome. Both directions are
    // unsafe from an unsettled caller: an unset cascades into materialize
    // tombstoning the rows, and an overwrite silently replaces a cell value
    // the user still owns (reconciling a populated cell against children is
    // the backfill's job, not a background repair's). Asked of the value being
    // BUILT, not of the snapshot, so a key an earlier field of this same owner
    // just added is one this field may not overwrite either — two fieldIds
    // resolve to one name whenever a definition is shadowed (§6).
    if (mode === 'additive' && Object.hasOwn(nextProperties, schema.name)) continue
    const fieldRows = fieldRowsForSchema(children, fieldId)
    // Additive mode also declines to break a TIE: adding the key is unsettled,
    // so materialize follows and `collapseDuplicateFieldRow` reaps the loser —
    // a background repair must not reap a user's row. Accepted cost: post-flip
    // both rows are recognized and hidden, and the key stays unset, until a
    // write to that property name or a rename migration converges them.
    // Editing the OWNER does not help — `collectAffectedProjection` maps a
    // CHANGED row through its own bit or its parent's.
    if (mode === 'additive' && fieldRows.length > 1) continue
    const projected = await projectedFieldValue(tx, schema, fieldRows)
    if (projected === undefined) {
      // LIVE field rows with no parseable value ⇒ key unset (default-value
      // rule, §9). A key with NO field rows AT ALL is only reachable here via
      // a child change that just deleted the last one — the deletion won.
      delete nextProperties[schema.name]
    } else {
      nextProperties[schema.name] = projected
    }
  }
  // Idempotence short-circuit (§5 invariant 1).
  if (propertiesEqual(parent.properties, nextProperties)) return
  await tx.update(parent.id, {properties: nextProperties}, {skipMetadata: true})
}

/**
 * Re-project every owner cell the given row STATES can affect — the
 * projection direction as a reusable unit, so the one place that knows how
 * a changed row maps to (owner, field) pairs stays the one place.
 *
 * `core.projectPropertyChildren` feeds it both sides of each change; the
 * raw column-repair paths (`Repo.stampReferenceTargets`, reached from the
 * per-open sweep and the alias-claim late-binding drain) feed it the rows
 * they stamped. Those write `reference_target_id` / `is_field_form` with a
 * bare UPDATE to preserve `updated_at`, which means NO processor observes
 * them — and a stamp that resolves a `::[[Foo]]` row's target is exactly
 * the moment that row starts being a recognized field row (§9 condition 3),
 * so without this call the owner's cell would never gain the key.
 *
 * Caller owns the flip gate: pre-flip there are no cells to project.
 */
export const reprojectOwnersForRowStates = async (
  tx: Tx,
  rowStates: Iterable<ProjectableRow | null>,
  lookups: ProjectionLookups,
  mode: ProjectionMode,
): Promise<void> => {
  const affected: AffectedOwners = new Map()
  // Collection reads; re-projection writes. Keeping them as two loops is what
  // lets the parent memo be a plain cache — no write can land between the
  // read that fills it and a later hit on it.
  const parents = new Map<string, BlockData | null>()
  const readParent: ParentReader = async (id) => {
    const cached = parents.get(id)
    if (cached !== undefined) return cached
    const parent = await tx.get(id)
    parents.set(id, parent)
    return parent
  }
  for (const row of rowStates) {
    await collectAffectedProjection(affected, row, lookups, readParent)
  }
  for (const [parentId, fields] of affected) {
    await reprojectOwner(tx, parentId, fields, mode)
  }
}

// ─── cell → children (materialize) ───────────────────────────────────────

const changedPropertyNames = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] => {
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed: string[] = []
  for (const name of names) {
    const beforeValue = Object.hasOwn(before, name) ? before[name] : undefined
    const afterValue = Object.hasOwn(after, name) ? after[name] : undefined
    if (!jsonValuesEqual(beforeValue, afterValue)) changed.push(name)
  }
  return changed
}

/** What to do with a cell value the materialize direction cannot carry —
 *  `propertyCellValueRejection`'s question, which is wider than the codec
 *  decode alone (see the rejection comment at the throw for why `'reject'` is
 *  the default).
 *
 *  `'skip'` is for names whose value THIS TX DID NOT WRITE. Rejecting one of
 *  those refuses nothing the caller can be blamed for and instead makes the row
 *  permanently un-restorable — a tombstoned row has no editing surface to
 *  repair the key from, so every later restore aborts the same way. The key is
 *  left as it was found (cell junk, no children); the next write to it rejects.
 *
 *  The policy is per CALL, so a caller reconciling both kinds of name splits
 *  them across two calls — see `materializePropertiesForChangedRow`. */
export type UndecodableCellPolicy = 'reject' | 'skip'

export interface MaterializeOptions {
  /** See {@link UndecodableCellPolicy}. Default `'reject'`. */
  undecodable?: UndecodableCellPolicy
  /** Bring a name's TOMBSTONED field row back instead of minting a
   *  replacement, when the owner has exactly one and no live one (#787).
   *
   *  Opt-in, and only the revival path opts in: it re-materializes the whole
   *  restored bag and would mint a replacement field row anyway, so reviving
   *  changes which row id carries the property, not whether it comes back. The
   *  cell backfill has no such contract and would resurrect what the user
   *  reaped — declined there. */
  reviveTombstoned?: boolean
  /** This call did not observe user intent for these names, so it may only ADD
   *  rows: never remove one, never rewrite one's content. The cell→children
   *  twin of the projection's `'additive'` mode, and for the same reason — an
   *  unobserved write must not be allowed to destroy what it did not see.
   *
   *  The revival path's untouched half is the caller: a restore re-materializes
   *  names the tx never wrote, from a cell that can be STALE against children a
   *  peer wrote while the owner was deleted, because sync-apply skips the
   *  parent-liveness trigger and lands an edit under a tombstoned row. Which
   *  side of a divergence is newer is not knowable here, so the tie goes to the
   *  children: post-flip they are the only property truth that crosses sync,
   *  and PROJECT heals the cell from them in the same tx. */
  additive?: boolean
}

/** Restore the tombstoned field row backing `fieldId`, together with its value
 *  children — so a revived property keeps its row identity instead of being
 *  replaced by a fresh mint. Returns whether anything came back.
 *
 *  One level down and no further: the field row and its value. Everything
 *  BELOW that stays tombstoned — a comment thread under the value (ordinary
 *  user content, like any other descendant of a restored block) and, under §9
 *  flat recognition, the value's own nested field rows if it carries properties
 *  of its own. What all of it must stop being is STRANDED: minting left it
 *  under a tombstoned value child nothing would ever revive, so no path could
 *  reach it again. Reviving the two rows above it restores the chain, which is
 *  the difference between "still deleted" and "gone".
 *
 *  A MULTI-VALUED property restores NO member row, by an explicit gate rather
 *  than by the count failing to match — see the gate for the case where it
 *  matches and must still not fire. What is lost is member row IDENTITY, never
 *  content: the caller's reconcile rebuilds every member from the cell, and the
 *  original rows keep their sub-children under a field row that is now LIVE,
 *  which is the stranding this helper exists to prevent.
 *
 *  ONE ambiguity rule, applied at both levels: revive only what is unambiguous.
 *  Several tombstones for one definition (an unset/re-set cycle before the
 *  owner was deleted), or several tombstoned values under one field row (a
 *  divergent conflict peer the user resolved by deleting it), are
 *  indistinguishable at revival time from rows the owner's own delete took
 *  down. Picking among them would need a rule that is deterministic across
 *  replicas AND right about which was live last; ordering gives the first, not
 *  the second, and guessing wrong resurrects a row the user deleted on purpose.
 *  So the ambiguous case revives nothing and the caller's loop mints from the
 *  cell — content converges either way, only identity is lost, and the
 *  tombstones stay reachable under a live parent instead of resurrected. */
const reviveTombstonedFieldRow = async (
  tx: Tx,
  schema: AnyPropertySchema & {readonly fieldId: string},
  tombstones: readonly BlockData[],
): Promise<boolean> => {
  const fieldId = schema.fieldId
  const matching = tombstones.filter(t => getPropertyFieldTargetId(t) === fieldId)
  if (matching.length !== 1) return false
  const fieldRow = matching[0]!
  // Bit-filtered per §9: a marked child is the field row's OWN machinery, never
  // one of its values.
  const isValue = (child: BlockData): boolean => child.isFieldForm !== true

  // Refuse BEFORE restoring anything, not after. Sync-apply skips the
  // parent-liveness trigger, so a LIVE value can sit under a tombstoned field
  // row, and restoring the field row would hand that value to the caller's
  // cell→child convergence, which overwrites its content with the local cell's.
  // This is also the ambiguity rule's live half — nothing live may hold the
  // slot — but the POSITION is what makes it a refusal rather than a repair.
  const liveValues = (await tx.childrenOf(fieldRow.id, undefined)).filter(isValue)
  if (liveValues.length > 0) return false

  await tx.restore(fieldRow.id)
  // The tombstone half, SINGLE-VALUED ONLY: exactly one offers to fill the
  // slot, and several are indistinguishable — see the one ambiguity rule above.
  //
  // A multi-valued property never takes it. At two or more members the count
  // cannot match, and at ZERO members — an explicitly empty list, which is a
  // first-class value — the one tombstone left under the field row is the
  // member the user DELETED to empty it. Restoring that resurrects the
  // deletion, and `additive` then forbids the reconciler from undoing the
  // resurrection. So the branch is, for a list, only ever a way to bring a
  // reaped member back.
  if (memberCodecOf(schema.codec) !== undefined) return true
  const values = (await tx.deletedChildrenOf(fieldRow.id)).filter(isValue)
  if (values.length === 1) await tx.restore(values[0]!.id)
  return true
}

/** Find-or-create/update/delete the field+value children for `names` on
 *  `row` from its cell values. Exported for slice C's one-time backfill,
 *  which points the same convergence at whole workspaces. */
export const materializePropertyChildrenForExistingRow = async (
  tx: Tx,
  row: BlockData,
  lookups: MaterializeLookups,
  names: readonly string[] = Object.keys(row.properties),
  opts: MaterializeOptions = {},
): Promise<void> => {
  const undecodable = opts.undecodable ?? 'reject'
  if (row.deleted) return
  if (names.length === 0) return

  let children = await tx.childrenOf(row.id, undefined)
  // Read once, on first need — most rows have no tombstoned field rows at all,
  // and the ones that do are asked about several names.
  let tombstones: BlockData[] | undefined

  for (const name of names) {
    const schema = lookups.resolveNameSchema(name)
    if (!schema) {
      // Unknown/shadowed/orphan key: leave the cell value untouched — §9's
      // orphan synthesis (slice C flip tooling) is what converts these,
      // never a silent skip-and-delete here.
      continue
    }
    const matchingChildren = fieldRowsForSchema(children, schema.fieldId)
    const encoded = Object.hasOwn(row.properties, name) ? row.properties[name] : undefined

    if (encoded === undefined) {
      // Key removed from the cell by a LOCAL write: the delete is the
      // user's intent — soft-delete the backing children (recoverable via
      // history). Distinct from the §5 pending-materialization rule, which
      // is about ABSENT CHILDREN never licensing cell-key deletion.
      for (const child of matchingChildren) {
        await deleteSubtreeInTx(tx, child.id)
      }
      continue
    }

    const rejection = propertyCellValueRejection(schema, encoded)
    if (rejection) {
      // The cell holds a value its schema's codec refuses — almost always a
      // raw `tx.update({properties})` that bypassed `setProperty`'s encode
      // step (setProperty can't produce an undecodable value). Silently
      // skipping here left the cell and the value child PERMANENTLY
      // divergent: the cell keeps the junk, the child keeps its stale value,
      // and PROJECT never reconciles them (it watches content, not
      // `properties`) — so in a flipped workspace the junk even syncs to
      // peers. Reject the write instead — a processor throw propagates out of
      // the writeTransaction and rolls the whole tx back atomically, so the
      // bad cell value never lands.
      //
      // Deliberately ASYMMETRIC with PROJECT, which DROPS the cell key for an
      // undecodable *child* value (see find-replace's forced-write path):
      // there the child is user-authored truth we must preserve, so we drop
      // the derived cell projection; here the raw cell write is ITSELF the
      // mistake, with no authored form to keep — so we refuse it.
      //
      // NOTE for slice C's backfill: it points this same helper at whole
      // workspaces, where a PRE-EXISTING legacy junk value must not abort the
      // entire flip. That caller must catch per row and report the offending
      // block, not let one bad value throw the whole pass.
      if (undecodable === 'skip') continue
      const failure = rejection.reason === 'decode'
        ? `does not decode under the "${schema.codec.type}" codec`
        : `decodes under the "${schema.codec.type}" codec but cannot be written ` +
          'as a value child'
      throw new Error(
        `Cannot materialize property "${name}" on block ${row.id}: its cell ` +
        `value ${failure}. Write property values through tx.setProperty / ` +
        `block.set, not a raw tx.update({properties}).`,
        {cause: rejection.cause},
      )
    }

    // Revive AFTER the rejection gate, never before it: a name the gate skipped
    // must be left exactly as the revival found it, and bringing its rows back
    // is not that — it would hand a stale child to a cell the skip declined to
    // touch, and post-flip the child is the side that wins.
    let fieldRows = matchingChildren
    if (opts.reviveTombstoned && fieldRows.length === 0) {
      tombstones ??= await tx.tombstonedPropertyFieldRows(row.workspaceId, row.id)
      if (await reviveTombstonedFieldRow(tx, schema, tombstones)) {
        children = await tx.childrenOf(row.id, undefined)
        fieldRows = fieldRowsForSchema(children, schema.fieldId)
      }
    }

    const fieldRow = await upsertFieldRow(
      tx, row, schema.fieldId, fieldRows, opts.additive,
    )
    await reconcileFieldValueChildren(tx, fieldRow, schema, encoded, opts.additive)
  }
}

/**
 * Materialize one changed row. Normally that means the bag DIFF — but a row
 * coming back from a tombstone reconciles its WHOLE bag, because the trigger
 * there is LIVENESS, not the bag.
 *
 * A subtree delete tombstones the owner's field and value rows along with it
 * (§9 machinery traversal), and a revival — `tx.restore`, with or without a
 * properties patch — usually leaves the bag identical. The diff is then empty,
 * so a diff-only rule schedules nothing and the row comes back holding a cell
 * value with no child-backed truth under it: post-flip the children ARE the
 * property, so every reader that has moved to them sees it as missing (#778).
 *
 * Undo/redo replay does NOT come through here — `applyRaw` drives each row to
 * its recorded snapshot with the same-tx pass skipped. It needs no revival
 * rule: the children written below land in the reviving tx's own snapshots, so
 * replaying that tx replays them too.
 */
const materializePropertiesForChangedRow = async (
  tx: Tx,
  row: {before: BlockData | null; after: BlockData | null},
  lookups: PropertyChildrenLookups,
): Promise<void> => {
  if (row.after === null || row.after.deleted) return
  const before = row.before
  const changed = changedPropertyNames(before?.properties ?? {}, row.after.properties)
  if (before === null || !before.deleted) {
    // Materialize-everything (§9 flat recognition): field rows and value rows
    // grow their own `::` children like every other block — recognition
    // reclaims nested machinery at any depth, so the old interior/prospective
    // carve-outs are deleted.
    await materializePropertyChildrenForExistingRow(tx, row.after, lookups, changed)
    return
  }
  // Revival re-materializes the diff PLUS the rest of the restored bag — a
  // restore usually leaves the bag identical, so a diff-only rule would
  // schedule nothing.
  //
  // Split by WHO WROTE THE VALUE: the decode rejection may only fire on names
  // this tx wrote, because a per-tx policy would let one untouched legacy
  // value veto a restore-then-write tx. A PARTITION, not an overlap —
  // overlapping is harmless only because the first call throws first, and
  // that would leave call ORDER load-bearing.
  const written = new Set(changed)
  const untouched = Object.keys(row.after.properties).filter(name => !written.has(name))
  await materializePropertyChildrenForExistingRow(
    tx, row.after, lookups, changed, {reviveTombstoned: true},
  )
  await materializePropertyChildrenForExistingRow(
    tx, row.after, lookups, untouched,
    {undecodable: 'skip', reviveTombstoned: true, additive: true},
  )
}

/** Find-or-create the field row for `fieldId` under `owner`, keeping its
 *  content canonical and folding any duplicate field rows into the survivor.
 *  Returns the row whose value children the caller then reconciles.
 *
 *  Shared by `tx.setProperty`'s eager dual-write and the deferred materialize
 *  processor for the same reason `reconcileFieldValueChildren` is: the row the
 *  two writers find-or-create has to be the same row, born with the same
 *  derived columns.
 *
 *  Collapse happens HERE, before the caller reconciles: collapsing relocates a
 *  duplicate's value children under the survivor, and a reconcile that ran
 *  first would not see them — so for a list the members hiding under the
 *  duplicate survive a removal and the projection puts them straight back. */
export const upsertFieldRow = async (
  tx: Tx,
  owner: Pick<BlockData, 'id' | 'workspaceId'>,
  fieldId: string,
  existingRows: readonly BlockData[],
  /** See {@link MaterializeOptions.additive}. */
  additive = false,
): Promise<Pick<BlockData, 'id' | 'workspaceId'>> => {
  const content = propertyFieldContent(fieldId)
  const [primary, ...duplicates] = existingRows
  if (primary) {
    // An additive call leaves an existing row's content alone. A field row's
    // content is machinery, but the canonical `::((fieldId))` is not its only
    // legal spelling: `::[[Name]]` resolves to the same fieldId (measured), and
    // it is what a rename's clean 1-for-1 leaves behind — so canonicalizing
    // here reverts a respelling that arrived while the owner was deleted.
    if (!additive && primary.content !== content) await tx.update(primary.id, {content})
    for (const duplicate of duplicates) {
      await collapseDuplicateFieldRow(tx, primary.id, duplicate, additive)
    }
    return primary
  }
  // Machinery inserts field rows FIRST among children (§9 ordering
  // decision): fields cluster above content as an emergent default;
  // orderKey stays user-owned afterwards.
  const id = await tx.create({
    workspaceId: owner.workspaceId,
    parentId: owner.id,
    // Born classified (§9): both derived columns pre-stamped in the create so
    // the row classifies and projects within the same single pass.
    referenceTargetId: fieldId,
    isFieldForm: true,
    orderKey: keyAtStart(null),
    content,
  })
  return {id, workspaceId: owner.workspaceId}
}

/**
 * Reconcile ONE field row's value children to `contents` — the content of each
 * value child, in sibling order, as {@link encodedPropertyValueToChildContents}
 * computed it from the owner's cell.
 *
 * THE cell → children writer. `tx.setProperty`'s eager dual-write and the
 * deferred materialize processor both come through here, because the two must
 * not be able to disagree about what a cell value's children are; the pass over
 * a whole workspace and the deferred re-encode inherit it via the materializer.
 *
 * The two cases differ in what an EXTRA child means, which is why they are
 * named branches rather than one loop:
 *
 *   SINGLE-VALUED — the sibling set is a CONFLICT surface. One primary value
 *   child carries the value; a divergent peer is a merge's or a concurrent
 *   write's surfaced conflict and is KEPT (§9), with only exact duplicates of
 *   what we just wrote folded in.
 *
 *   MULTI-VALUED — the siblings ARE the value, multiplicity included. An extra
 *   child is a member, so "the list is now [a]" has to be able to remove one:
 *   members not named by the cell are deleted, and a cell asking for `[2, 2]`
 *   keeps two rows. Divergence is not lost by that — concurrent writes diverge
 *   as ARRIVALS, which never pass through here, and stay as visible sibling
 *   rows. What passes through here is a local write, which is intent.
 */
export const reconcileFieldValueChildren = async (
  tx: Tx,
  fieldRow: Pick<BlockData, 'id' | 'workspaceId'>,
  schema: AnyPropertySchema,
  encoded: unknown,
  /** See {@link MaterializeOptions.additive}. */
  additive = false,
): Promise<void> => {
  // Takes the ENCODED VALUE, not the contents, so the grain cannot be decided
  // by a caller: a scalar has exactly one content here by construction, which
  // is what lets the single-value branch below take a `string` rather than a
  // list it has to defend against being empty.
  const contents = encodedPropertyValueToChildContents(schema, encoded)
  // §9 value set: bit-filtered, in `(order_key, id)` order — a nested marked
  // row under the field row is its own machinery, never a value candidate.
  const values = await fieldValueChildren(tx, fieldRow.id)
  if (memberCodecOf(schema.codec) === undefined) {
    await reconcileSingleValueChild(tx, fieldRow, values, contents[0]!, additive)
    return
  }
  await reconcileMemberValueChildren(tx, fieldRow, schema, values, contents, additive)
}

const createValueChild = (
  tx: Tx,
  fieldRow: Pick<BlockData, 'id' | 'workspaceId'>,
  content: string,
  orderKey: string,
): Promise<string> => tx.create({
  workspaceId: fieldRow.workspaceId,
  parentId: fieldRow.id,
  orderKey,
  content,
})

const reconcileSingleValueChild = async (
  tx: Tx,
  fieldRow: Pick<BlockData, 'id' | 'workspaceId'>,
  values: readonly BlockData[],
  content: string,
  /** See {@link MaterializeOptions.additive}. */
  additive: boolean,
): Promise<void> => {
  const [primary, ...duplicates] = values
  if (!primary) {
    await createValueChild(tx, fieldRow, content, keyAtStart(null))
    return
  }
  // An additive call may not touch the one slot a scalar has. Giving the value
  // set a row it lacks is the whole of what it is allowed to do, and the set is
  // not empty — so nothing below applies, the fold included: every comparison
  // there is against `content`, the cell value the primary was just permitted
  // to disagree with, which would fold a row that is no duplicate of it (#1021).
  if (additive) return
  if (primary.content !== content) await tx.update(primary.id, {content})
  // Fold only EXACT duplicates of the projected cell value (concurrent
  // dual-writes of the same value); DIVERGENT siblings are a surfaced
  // conflict — from a merge or divergent concurrent write — and are kept as
  // peer values, not silently collapsed onto the winner.
  for (const duplicate of duplicates) {
    if (duplicate.content === content) {
      await collapseDuplicateValueChild(tx, primary.id, duplicate)
    }
  }
}

const freshSlots = (
  values: readonly BlockData[],
  count: number,
): string[] => {
  // `fieldValueChildren` returns `(order_key, id)` order, so the last row
  // carries the largest key.
  const anchor = values.at(-1)?.orderKey ?? null
  try {
    return keysBetween(anchor, null, count)
  } catch {
    return keysBetween(null, null, count)
  }
}

const reconcileMemberValueChildren = async (
  tx: Tx,
  fieldRow: Pick<BlockData, 'id' | 'workspaceId'>,
  schema: AnyPropertySchema,
  values: readonly BlockData[],
  contents: readonly string[],
  additive: boolean,
): Promise<void> => {
  // By VALUE, not raw text: a member a person spelled ` 1 ` projects to exactly
  // what the canonical text projects to, and matching on text alone reaps that
  // row — with its comments, its own properties and its history — to mint a
  // replacement for a value that never changed.
  const keys = memberKeysFor(schema)
  const keyByRow = new Map(values.map(value => [value.id, keys.row(value)]))

  // Occurrence by occurrence, so a list holding one member twice consumes two
  // rows and a shortened list drops the surplus one rather than the wrong one.
  const unused = new Map<string, BlockData[]>()
  for (const value of values) {
    const key = keyByRow.get(value.id)!.key
    const bucket = unused.get(key)
    if (bucket) bucket.push(value)
    else unused.set(key, [value])
  }
  const kept = contents.map(content => unused.get(keys.content(content))?.shift())

  // Everything unmatched, in the order the value set was read, so replicas
  // agree on which of several equal rows survives.
  const keptRows = new Set(kept)
  const surplus = values.filter(value => !keptRows.has(value))

  // `additive` governs EVERY removal, folding included: a fold takes a row
  // away, and multiplicity is part of a list's value, so a repeated member that
  // arrived unobserved has to survive one too.
  if (!additive) {
    for (const row of surplus) {
      // A surplus row equal to a member we are keeping is one copy too many —
      // the match above consumed one row per member the cell asked for — and it
      // folds, relocating its user-authored sub-children under the survivor
      // instead of being tombstoned with it. A surplus row matching no member
      // is a member the cell removed.
      const survivor = kept.find(k =>
        k !== undefined && keyByRow.get(k.id)!.key === keyByRow.get(row.id)!.key)
      if (survivor) await collapseDuplicateValueChild(tx, survivor.id, row)
      // An UNPARSEABLE surplus row is not a member the cell removed — it is a
      // member the cell never held, because the projection could not read it.
      // Reaping it here would delete a row the user still has to repair, and
      // its sub-children with it, on an unrelated write to the same property.
      // Kept, exactly as the scalar branch keeps a divergent peer; removing it
      // is a delete in the tree, which is how any value row goes.
      else if (keyByRow.get(row.id)!.denotesValue) await deleteSubtreeInTx(tx, row.id)
    }
  }

  // Members permute among the order-key SLOTS the value children already
  // occupy, so an unchanged list writes nothing (§5 invariant 1: idempotence). A
  // member added anywhere but the end therefore re-keys the members after it;
  // list properties here hold a handful of members, and the alternative —
  // allocating between neighbours — is a second ordering rule to keep correct
  // for a cost nothing has measured.
  //
  // DISTINCT slots: synced or imported rows can share an `order_key`, and a
  // tied pair cannot express an order at all — SQLite falls back to the id, so
  // a reorder completes and then projects back in the old order. Collapsing the
  // tie to one slot and topping up with fresh keys gives every member a key of
  // its own.
  const freed = [...new Set(kept.filter(k => k !== undefined).map(k => k.orderKey))]
  const created = contents.length - freed.length
  // After every existing value row, so a fresh slot never lands on one already
  // taken. The generator REFUSES an anchor it cannot parse, and `tx.create`
  // validates no order key — so one hand-written or imported sibling under this
  // field row ('zzz', 'k-1', '') would otherwise throw out of the processor and
  // roll back the user's whole transaction, on every growth write to that
  // property, for as long as the row exists. Falling back to a fresh band keeps
  // the write working; `slots` is sorted, so the members stay in list order
  // either way, and only their position relative to the unparseable row moves.
  const fresh = created > 0 ? freshSlots(values, created) : []
  const slots = [...freed, ...fresh].sort()

  for (let i = 0; i < contents.length; i++) {
    const orderKey = slots[i]!
    const existing = kept[i]
    if (!existing) {
      await createValueChild(tx, fieldRow, contents[i]!, orderKey)
      continue
    }
    // Content is deliberately NOT rewritten to the canonical spelling: the row
    // matched BY VALUE, so its text already projects to what the cell asks for,
    // and rewriting it would edit text a person chose for no gain.
    if (existing.orderKey !== orderKey) {
      await tx.move(existing.id, {parentId: fieldRow.id, orderKey})
    }
  }
}

/** Move one row to the end of `parentId`'s children. */
const appendUnder = async (
  tx: Tx,
  child: BlockData,
  parentId: string,
  siblings: readonly BlockData[],
): Promise<void> => {
  const anchor = siblings.at(-1)?.orderKey ?? null
  await tx.move(child.id, {parentId, orderKey: keysBetween(anchor, null, 1)[0]!})
}

/** Move every child of `fromId` under `toId`, appended at the end. */
const relocateChildren = async (tx: Tx, fromId: string, toId: string): Promise<void> => {
  const movable = await tx.childrenOf(fromId, undefined)
  if (movable.length === 0) return
  const anchor = (await tx.childrenOf(toId, undefined))
    .at(-1)?.orderKey ?? null
  const keys = keysBetween(anchor, null, movable.length)
  for (let i = 0; i < movable.length; i++) {
    await tx.move(movable[i]!.id, {parentId: toId, orderKey: keys[i]!})
  }
}

/** §9 dedup, VALUE-child form: the survivor is picked deterministically by
 *  `(order_key, id)` — arbitrary relative to content — so the loser may carry
 *  user-authored sub-children. Relocate those under the survivor BEFORE
 *  deleting; a bare subtree-delete would silently tombstone them, and a shallow
 *  delete would orphan them live under a tombstone.
 *
 *  WHETHER to fold is the caller's call, and it differs by grain: an
 *  equal-valued sibling is a redundant copy of ONE value to a scalar, and an
 *  occurrence to a list. */
export const collapseDuplicateValueChild = async (
  tx: Tx,
  survivorValueId: string,
  duplicate: BlockData,
): Promise<void> => {
  await relocateChildren(tx, duplicate.id, survivorValueId)
  await deleteSubtreeInTx(tx, duplicate.id)
}

/** §9 dedup, FIELD-row form: before deleting a duplicate field row, its
 *  values must not silently vanish.
 *
 *  ACCEPTED for a MULTI-VALUED property, where folding an equal member merges
 *  two rows that are arguably two occurrences: the rejected alternative, a
 *  per-caller fold policy, buys row identity at the cost of a second policy
 *  axis, and `mergeBlocksInTx` needs the fold either way (union-with-dedupe is
 *  a merge gesture's settled policy). Content converges; the loser's
 *  sub-children move to the survivor rather than vanishing.
 *
 *  A duplicate's value that MATCHES an existing survivor value folds into it
 *  (sub-children relocate), and one that does not is kept as a peer SIBLING
 *  value under the survivor field row — never nested under the winner as if it
 *  were an annotation, never dropped. What the CELL then reads is not this
 *  helper's to say and differs by grain: a scalar keeps the first parseable
 *  value, so a conflicting peer stays visible beside it, while a multi-valued
 *  one aggregates every parseable member, duplicates included
 *  (`childContentsToEncodedPropertyValue`). */
export const collapseDuplicateFieldRow = async (
  tx: Tx,
  survivorFieldRowId: string,
  duplicate: BlockData,
  /** See {@link MaterializeOptions.additive}. A fold here takes a member
   *  row away exactly as the reconciler's does, and it happens BEFORE the
   *  reconciler is handed the policy — so a caller that may not reap has to
   *  say so here too, or an arrival that duplicated an existing member is
   *  collapsed on the way past and the reconciler never sees the occurrence
   *  it was meant to preserve. */
  additive = false,
): Promise<void> => {
  const duplicateChildren = await tx.childrenOf(
    duplicate.id, undefined,
  )
  // The SAME comparison the member reconciler uses — see `MemberKeys` for what
  // a disagreement between the two costs. Resolves to raw-text matching for a
  // scalar, and for a field row whose definition does not resolve.
  const fieldId = getPropertyFieldTargetId(duplicate)
  const keys = memberKeysFor(fieldId === undefined
    ? null
    : tx.resolvePropertyFieldSchema(duplicate.workspaceId, fieldId))
  for (const child of duplicateChildren) {
    const survivorChildren = await tx.childrenOf(
      survivorFieldRowId, undefined,
    )
    // §9 selection discipline: a duplicate's own MARKED children are its
    // field rows (its own properties' machinery), never value candidates —
    // routing one through value folding would nest machinery under the
    // survivor's value or surface it as a peer value. Fold field rows as
    // field rows, recursively: into the survivor's own field row for the
    // same fieldId when one exists, else move over intact (it stays a
    // recognized field row of the survivor — content-intrinsic, move-proof).
    if (child.isFieldForm === true) {
      const childFieldId = getPropertyFieldTargetId(child)
      const survivorOwn = survivorChildren.find(c =>
        c.isFieldForm === true
        && childFieldId !== undefined
        && getPropertyFieldTargetId(c) === childFieldId)
      if (survivorOwn) {
        await collapseDuplicateFieldRow(tx, survivorOwn.id, child, additive)
      } else {
        await appendUnder(tx, child, survivorFieldRowId, survivorChildren)
      }
      continue
    }
    const survivorValues = survivorChildren.filter(isFieldValueChild)
    const match = additive
      ? undefined
      : survivorValues.find(v => keys.row(v).key === keys.row(child).key)
    if (match) {
      await collapseDuplicateValueChild(tx, match.id, child)
    } else {
      await appendUnder(tx, child, survivorFieldRowId, survivorChildren)
    }
  }
  await deleteSubtreeInTx(tx, duplicate.id)
}

// ─── processors ───────────────────────────────────────────────────────────

export const MATERIALIZE_PROPERTY_CHILDREN_PROCESSOR = defineSameTxProcessor({
  name: MATERIALIZE_PROPERTY_CHILDREN_PROCESSOR_NAME,
  // `deleted` alongside `properties` so a REVIVAL re-materializes even when the
  // bag did not change (`materializePropertiesForChangedRow`) — the bag is what
  // this direction reads, but liveness is what takes the children away. Same
  // reason `core.aliasClaimRederive` watches it. Rows going the other way match
  // too and are dropped by the `after.deleted` guard.
  watches: {kind: 'field', table: 'blocks', fields: ['properties', 'deleted']},
  // Issue #402: re-runs over rows dirtied after it ran, so (a) a plugin's
  // raw bag write (merge retarget) grows/updates its backing children in
  // the same tx, and (b) a row that STOPPED being a field row this tx
  // (derive cleared the stamp after this processor's stale-column
  // ancestry read skipped it) still gets its bag materialized. The
  // definition-change processor's cell re-keys are settledWrites and never
  // reach this re-run — see MIGRATE_PROPERTY_DEFINITION_PROCESSOR.
  rerunOnDirtyRows: true,
  apply: async (event, ctx) => {
    // Workspace flip gate (§6): one predicate, checked once — a tx pins a
    // single workspace, and un-flipped workspaces are fully dormant.
    if (!(await ctx.tx.isPropertyChildBackedWorkspace(event.workspaceId))) return
    const lookups = lookupsFor(ctx, event.workspaceId)
    for (const row of event.changedRows) {
      await materializePropertiesForChangedRow(ctx.tx, row, lookups)
    }
  },
})

export const PROJECT_PROPERTY_CHILDREN_PROCESSOR = defineSameTxProcessor({
  name: PROJECT_PROPERTY_CHILDREN_PROCESSOR_NAME,
  // `isFieldForm` is watched: projection's classification
  // and value-set both read the bit, so a bit-only change (arrival repair,
  // the catch-up sweep stamping existing marked rows) must re-project; bulk
  // repair paths that write the bit raw enqueue projection explicitly.
  watches: {kind: 'field', table: 'blocks', fields: ['content', 'referenceTargetId', 'isFieldForm', 'parentId', 'orderKey', 'deleted']},
  // Issue #402: a plugin rewriting field/value-row content after this
  // ran (merge retarget on a value child or on a definition's field
  // rows, alias reverse-sync turning a child into `::((fieldId))`,
  // deleted-ref inlining) re-projects the owner's cell here instead of
  // leaving it keyed to pre-rewrite children.
  rerunOnDirtyRows: true,
  // settledWrites: the cell this processor writes is a DERIVED READ
  // SURFACE over the children (§5's one-direction rule) — nothing may
  // re-derive truth from it. Concretely, the projection is lossy on
  // purpose: an unparseable value child unsets the cell key while the
  // rows stay visible/fixable (§9), and a re-run MATERIALIZE reading
  // that unset as a user's key deletion would tombstone the very rows
  // the rule preserves. MATERIALIZE stays unsettled by the same logic
  // in reverse: its child writes ARE truth, and pass-two DERIVE needs
  // to see them to stamp fresh value children.
  settledWrites: true,
  apply: async (event, ctx) => {
    if (!(await ctx.tx.isPropertyChildBackedWorkspace(event.workspaceId))) return
    // Both sides of a move: the old parent loses the key, the new parent
    // gains it (§9 reparent semantics).
    await reprojectOwnersForRowStates(
      ctx.tx,
      event.changedRows.flatMap(row => [row.before, row.after]),
      lookupsFor(ctx, event.workspaceId),
      // Authoritative: this processor's writes ARE settled, which is what
      // makes the lossy unset safe here and nowhere else.
      'full',
    )
  },
})
