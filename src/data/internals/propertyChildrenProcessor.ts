/**
 * Property-children convergence processors (PR #288 §5, extracted from the
 * PR #285 spike). Both are PERMANENT machinery, not migration scaffolding,
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
  type AnyPropertySchema,
  type BlockData,
  type ResolvedPropertySchema,
  type SameTxCtx,
  type Tx,
} from '@/data/api'
import { keyAtStart, keysBetween } from '@/data/orderKey'
import {
  encodedPropertyValueToChildContent,
  getPropertyFieldTargetId,
  fieldValueChildren,
  isFieldValueChild,
  propertiesEqual,
  propertyFieldContent,
  propertyChildContentToEncodedValue,
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

// §9 flat recognition deleted the write-side positional machinery this
// factory used to build (the interior-ancestry walk and the prospective-
// field-row content probe): classification is content-intrinsic via the
// `is_field_form` bit, field/value rows materialize their own bags like
// every other block, and the selection predicates below key on the bit.
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

const hasOwn = (properties: Record<string, unknown>, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(properties, name)

interface AffectedProjection {
  readonly parentId: string
  readonly fieldId: string
}

const affectedKey = (affected: AffectedProjection): string =>
  `${affected.parentId}\u0000${affected.fieldId}`

const addAffectedProjection = (
  out: Map<string, AffectedProjection>,
  parentId: string | null,
  fieldId: string | undefined,
  lookups: ProjectionLookups,
): void => {
  if (parentId === null) return
  if (fieldId === undefined) return
  if (!lookups.resolveFieldSchema(fieldId)) return
  const affected = {parentId, fieldId}
  out.set(affectedKey(affected), affected)
}

/** Walk up at most two levels from a changed row to the (parent, fieldId)
 *  pairs it can affect: the row as a field row (parent = owning block), and
 *  the row as a value child (parent = field row → owning block). Both the
 *  before and after sides of a move are collected by the caller. */
const collectAffectedProjection = async (
  tx: Tx,
  out: Map<string, AffectedProjection>,
  row: ProjectableRow | null,
  lookups: ProjectionLookups,
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
  const parent = await tx.get(row.parentId)
  if (parent === null || parent.parentId === null) return
  // The row as a VALUE child (parent = field row → owning block): only a
  // marked parent is a field row, and only a non-marked row is its value.
  if (parent.isFieldForm === true && isFieldValueChild(row)) {
    addAffectedProjection(out, parent.parentId, getPropertyFieldTargetId(parent), lookups)
  }
}

/** First parseable value across the field rows for a schema, in
 *  deterministic `(order_key, id)` order — the projection's value rule
 *  (§9): unparseable children are skipped; if nothing parses the key reads
 *  as unset while the rows stay visible/fixable in the tree.
 *
 *  Denoted-value rule (§5): only DIRECT value children are read — a
 *  comment deep under a value child never re-projects the parent. */
const firstProjectedFieldValue = async (
  tx: Tx,
  schema: AnyPropertySchema,
  fieldRows: readonly BlockData[],
): Promise<unknown | undefined> => {
  for (const fieldRow of fieldRows) {
    // §9 value set: `is_field_form IS NOT 1` children only — a nested marked
    // row materialized under the field row is its own machinery, never a
    // value candidate.
    const values = await fieldValueChildren(tx, fieldRow.id)
    for (const value of values) {
      try {
        return propertyChildContentToEncodedValue(schema, value.content)
      } catch {
        // Invalid child text should not preserve a stale parent cell
        // projection. Skip it; if no child under this field parses, the
        // parent property is removed below.
      }
    }
  }
  return undefined
}

// §9 selection: the bit + target pair (the JS twin of
// SELECT_PROPERTY_FIELD_CHILD_SQL) — without the bit an unmarked
// `((fieldId))` link row would be selected as the field row.
const fieldRowsForSchema = (
  children: readonly BlockData[],
  fieldId: string,
): BlockData[] => children.filter(child =>
  child.isFieldForm === true && getPropertyFieldTargetId(child) === fieldId)

const reprojectParentField = async (
  tx: Tx,
  affected: AffectedProjection,
  lookups: ProjectionLookups,
  mode: ProjectionMode,
): Promise<void> => {
  const schema = lookups.resolveFieldSchema(affected.fieldId)
  if (!schema) return

  const parent = await tx.get(affected.parentId)
  if (parent === null || parent.deleted) return
  // Additive mode stops at a key the owner already holds — BEFORE the value
  // scan, since the answer can't change the outcome. Both directions are
  // unsafe from an unsettled caller: an unset cascades into materialize
  // tombstoning the rows, and an overwrite silently replaces a cell value
  // the user still owns (reconciling a populated cell against children is
  // the backfill's job, not a background repair's).
  if (mode === 'additive' && hasOwn(parent.properties, schema.name)) return
  // No interior gate (§9 flat recognition): ANY block — value rows and
  // field rows included — hosts field rows via its `::` children, and its
  // cell projects from them like every other owner's. The old hazard (a
  // ref-typed value misread as a field row of its parent) is structurally
  // gone: unmarked rows never classify.
  const children = await tx.childrenOf(affected.parentId, undefined)
  const fieldRows = fieldRowsForSchema(children, affected.fieldId)
  // Additive mode also declines to break a TIE. Adding the key is an
  // unsettled write, so materialize follows it — and with two field rows for
  // one definition that means `collapseDuplicateFieldRow`, which tombstones
  // the loser and uploads the tombstone. A background repair has no business
  // reaping a user's row, so this bails instead.
  //
  // Be clear about what the user gets, because it is not "the duplicate
  // stays visible": post-flip BOTH rows are recognized, so both are filtered
  // out of every `hidePropertyChildren` listing (which the outline hooks
  // always pass), and the cell key stays unset — so the property and its
  // rows are all invisible until something converges them. Nor does editing
  // the OWNER help: `collectAffectedProjection` maps a changed row through
  // its own bit or its parent's, so the owner's own edits don't reproject
  // its field. It takes a write to that property name (setProperty →
  // materialize → collapse) or a definition-rename migration. Nothing is
  // lost and it does converge, but the trade is "temporarily invisible" vs
  // "silently reaped" — not "visible" vs "reaped".
  if (mode === 'additive' && fieldRows.length > 1) return
  const projected = await firstProjectedFieldValue(tx, schema, fieldRows)
  const nextProperties = {...parent.properties}
  if (projected === undefined) {
    // LIVE field rows with no parseable value ⇒ key unset (default-value
    // rule, §9). A key with NO field rows AT ALL is only reachable here via
    // a child change that just deleted the last one — the deletion won.
    delete nextProperties[schema.name]
  } else {
    nextProperties[schema.name] = projected
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
  const affected = new Map<string, AffectedProjection>()
  for (const row of rowStates) {
    await collectAffectedProjection(tx, affected, row, lookups)
  }
  for (const projection of affected.values()) {
    await reprojectParentField(tx, projection, lookups, mode)
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
    const beforeValue = hasOwn(before, name) ? before[name] : undefined
    const afterValue = hasOwn(after, name) ? after[name] : undefined
    if (!jsonValuesEqual(beforeValue, afterValue)) changed.push(name)
  }
  return changed
}

/** What to do with a cell value that does not decode under its schema's codec
 *  (see the rejection comment at the throw for why `'reject'` is the default).
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
   *  Opt-in, and only the revival path opts in. NOT because owner liveness
   *  tells a tombstone's cause apart — it does not, and an earlier version of
   *  this comment claimed otherwise. An owner returning from a tombstone can
   *  carry a field-row tombstone OLDER than its own delete (a peer's deletion
   *  arrived, this device's cell has not caught up — the stale-cell state
   *  `propertyCellBackfill` reads as history), and nothing local separates that
   *  from a row the owner's own subtree delete took down.
   *
   *  What makes reviving safe for THIS caller is narrower and checkable: the
   *  revival already re-materializes the whole restored bag, so for a name with
   *  a stale cell key it MINTS a replacement field row today. Reviving changes
   *  which row id carries that, not whether the property comes back — measured
   *  both ways. The cell backfill has no such contract, and reviving there
   *  would resurrect what the user reaped, so it stays out.
   *
   *  The resurrection itself is real and predates this option; it is the
   *  revival contract's own problem, tracked separately. */
  reviveTombstoned?: boolean
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
  fieldId: string,
  tombstones: readonly BlockData[],
): Promise<boolean> => {
  const matching = tombstones.filter(t => getPropertyFieldTargetId(t) === fieldId)
  if (matching.length !== 1) return false
  const fieldRow = matching[0]!
  await tx.restore(fieldRow.id)
  // Bit-filtered per §9: a marked child is the field row's OWN machinery, never
  // one of its values. Not revived either — see the one-level-down note above.
  const values = (await tx.deletedChildrenOf(fieldRow.id))
    .filter(value => value.isFieldForm !== true)
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
    const encoded = hasOwn(row.properties, name) ? row.properties[name] : undefined

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

    try {
      schema.codec.decode(encoded)
    } catch (cause) {
      // The cell holds a value that doesn't decode under its schema's codec —
      // almost always a raw `tx.update({properties})` that bypassed
      // `setProperty`'s encode step (setProperty can't produce an undecodable
      // value). Silently skipping here left the cell and the value child
      // PERMANENTLY divergent: the cell keeps the junk, the child keeps its
      // stale value, and PROJECT never reconciles them (it watches content,
      // not `properties`) — so in a flipped workspace the junk even syncs to
      // peers. Reject the write instead — a processor throw propagates out of
      // the writeTransaction and rolls the whole tx back atomically, so the
      // bad cell value never lands (PR #386 review, F2; Vlad).
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
      throw new Error(
        `Cannot materialize property "${name}" on block ${row.id}: its cell ` +
        `value does not decode under the "${schema.codec.type}" codec. Write ` +
        `property values through tx.setProperty / block.set, not a raw ` +
        `tx.update({properties}).`,
        {cause},
      )
    }

    // Revive AFTER the decode gate, never before it: a name the gate skipped
    // must be left exactly as the revival found it, and bringing its rows back
    // is not that — it would hand a stale child to a cell the skip declined to
    // touch, and post-flip the child is the side that wins.
    let fieldRows = matchingChildren
    if (opts.reviveTombstoned && fieldRows.length === 0) {
      tombstones ??= await tx.tombstonedPropertyFieldRows(row.workspaceId, row.id)
      if (await reviveTombstonedFieldRow(tx, schema.fieldId, tombstones)) {
        children = await tx.childrenOf(row.id, undefined)
        fieldRows = fieldRowsForSchema(children, schema.fieldId)
      }
    }

    const content = encodedPropertyValueToChildContent(schema, encoded)
    const [primary, ...duplicates] = fieldRows
    if (primary) {
      const fieldContent = propertyFieldContent(schema.fieldId)
      if (primary.content !== fieldContent) {
        await tx.update(primary.id, {content: fieldContent})
      }
      // §9 value set: bit-filtered — nested marked rows are machinery.
      const values = await fieldValueChildren(tx, primary.id)
      const [primaryValue, ...duplicateValues] = values
      if (primaryValue) {
        if (primaryValue.content !== content) {
          await tx.update(primaryValue.id, {content})
        }
        // Fold only EXACT duplicates of the projected cell value (concurrent
        // dual-writes of the same value); DIVERGENT siblings are a surfaced
        // conflict — from a merge or divergent concurrent write — and are
        // kept as peer values, not silently collapsed onto the winner.
        for (const duplicate of duplicateValues) {
          if (duplicate.content === content) {
            await collapseDuplicateValueChild(tx, primaryValue.id, duplicate)
          }
        }
      } else {
        await tx.create({
          workspaceId: row.workspaceId,
          parentId: primary.id,
          orderKey: keyAtStart(null),
          content,
        })
      }
    } else {
      const fieldRowId = await tx.create({
        workspaceId: row.workspaceId,
        parentId: row.id,
        // Born classified (§9): both derived columns pre-stamped so the row
        // classifies and projects within the same single pass.
        referenceTargetId: schema.fieldId,
        isFieldForm: true,
        orderKey: keyAtStart(null),
        content: propertyFieldContent(schema.fieldId),
      })
      await tx.create({
        workspaceId: row.workspaceId,
        parentId: fieldRowId,
        orderKey: keyAtStart(null),
        content,
      })
    }

    for (const child of duplicates) {
      await collapseDuplicateFieldRow(tx, primary?.id ?? child.id, child)
    }
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
  // Revival: the diff PLUS the rest of the restored bag, which is the half a
  // diff-driven rule misses. A key the restore patch DROPPED needs no special
  // handling — dropping it IS a diff, so it rides `changed` into the reap
  // branch that tombstones children a non-subtree delete left live.
  //
  // Split by WHO WROTE THE VALUE, because that is what the decode rejection is
  // about. Both halves land in the SAME tx on real paths — restore a tombstone,
  // then write properties on the row you just restored:
  // `createOrRestoreTargetBlock`'s `onInsertedOrRestored` (media capture,
  // daily-note seats) and `getOrCreateKernelPage`'s hand-rolled equivalent. A
  // per-tx policy would let one untouched legacy value veto those restores
  // outright — the exact stranding the exemption exists to prevent.
  //
  // Reachable twice per tx: MATERIALIZE opts into the issue-#402 re-run, so a
  // later unsettled write to the owner row (DERIVE stamping a restore's content
  // patch) re-enters this branch. For a content-only trigger `rerunBefore` hands
  // back the same bag pair, so the split is identical and the writes below
  // no-op; a re-run whose trigger also moved the bag re-splits, which is equally
  // fine — the halves stay correct however the names fall.
  // A partition rather than an overlap. Overlapping is harmless today — the
  // first call throws before the second runs, and materialize is idempotent
  // otherwise — but it would make the call ORDER the only thing keeping a
  // written name's rejection, and that is not a thing to leave load-bearing.
  const written = new Set(changed)
  const untouched = Object.keys(row.after.properties).filter(name => !written.has(name))
  await materializePropertyChildrenForExistingRow(
    tx, row.after, lookups, changed, {reviveTombstoned: true},
  )
  await materializePropertyChildrenForExistingRow(
    tx, row.after, lookups, untouched, {undecodable: 'skip', reviveTombstoned: true},
  )
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

/** §9 dedup, VALUE-child form (shared by the same-tx materializer and
 *  `tx.setProperty`'s dual-write): the survivor is picked deterministically
 *  by `(order_key, id)` — arbitrary relative to content — so the loser may
 *  carry user-authored sub-children (a comment thread under the losing
 *  value). Relocate those under the survivor BEFORE deleting; a bare
 *  subtree-delete would silently tombstone them, and a shallow delete would
 *  orphan them live under a tombstone (the two divergent semantics the
 *  spike's call sites had — unified here). */
export const collapseDuplicateValueChild = async (
  tx: Tx,
  survivorValueId: string,
  duplicate: BlockData,
): Promise<void> => {
  await relocateChildren(tx, duplicate.id, survivorValueId)
  await deleteSubtreeInTx(tx, duplicate.id)
}

/** §9 dedup, FIELD-row form: before deleting a duplicate field row, its
 *  values must not silently vanish. A field row holds a SET of value children,
 *  deduped by content — so a duplicate's value that MATCHES an existing
 *  survivor value folds into it (sub-children relocate), and a DIVERGENT value
 *  is kept as a peer SIBLING value under the survivor field row. Projection
 *  reads the first value, so the cell keeps the survivor's winner while the
 *  conflicting value stays visible and reconcilable — never nested under the
 *  winner as if it were an annotation, never dropped. */
export const collapseDuplicateFieldRow = async (
  tx: Tx,
  survivorFieldRowId: string,
  duplicate: BlockData,
): Promise<void> => {
  const duplicateChildren = await tx.childrenOf(
    duplicate.id, undefined,
  )
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
        await collapseDuplicateFieldRow(tx, survivorOwn.id, child)
      } else {
        const anchor = survivorChildren.at(-1)?.orderKey ?? null
        await tx.move(child.id, {parentId: survivorFieldRowId, orderKey: keysBetween(anchor, null, 1)[0]!})
      }
      continue
    }
    const survivorValues = survivorChildren.filter(isFieldValueChild)
    const match = survivorValues.find(v => v.content === child.content)
    if (match) {
      await collapseDuplicateValueChild(tx, match.id, child)
    } else {
      const anchor = survivorChildren.at(-1)?.orderKey ?? null
      await tx.move(child.id, {parentId: survivorFieldRowId, orderKey: keysBetween(anchor, null, 1)[0]!})
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
  // rename processor's cell re-keys are settledWrites and never reach
  // this re-run — see MIGRATE_PROPERTY_RENAME_PROCESSOR.
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
  // `isFieldForm` is watched (PR #417 review): projection's classification
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
