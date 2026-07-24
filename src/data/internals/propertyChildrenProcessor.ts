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
  isInsidePropertySubtreeWalk,
  propertiesEqual,
  propertyFieldContent,
  propertyChildContentToEncodedValue,
} from '@/data/propertyChildren'
import { parseExactReferenceBlockContent } from '@/data/referenceBlock'
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
  /** §9 positional rule for the WRITE side (adversarial-review round 2):
   *  does this block's chain (self included) pass through a field row?
   *  Field-row-ness here counts shadowed losers (they classify at read
   *  sites), matching the tx-layer checker. Memoized per processor apply. */
  isInsidePropertySubtree: (id: string | null) => Promise<boolean>
  /** Will `core.deriveReferenceTarget` stamp this row as a field row at
   *  commit? Content-based twin of the stored-column recognition — this
   *  processor runs BEFORE derive in the same-tx chain, so a row whose
   *  content was just rewritten to `[[schema]]` still carries a stale
   *  column that `isInsidePropertySubtree`'s first step would misread
   *  (PR #386 review; mirrors `TxImpl.isProspectiveFieldRow`, including
   *  the root exemption — root rows are never field rows). */
  isProspectiveFieldRow: (row: Pick<BlockData, 'content' | 'parentId'>) => boolean
}

const lookupsFor = (ctx: SameTxCtx, workspaceId: string): PropertyChildrenLookups => {
  const isFieldDefinition = (fieldId: string): boolean => {
    const resolution = ctx.resolvePropertySchemaField(workspaceId, fieldId)
    return resolution.status === 'resolved'
      || (resolution.status === 'identity-unavailable' && resolution.reason === 'shadowed')
  }
  const subtreeMemo = new Map<string, boolean>()
  return {
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
    isInsidePropertySubtree: (id) => isInsidePropertySubtreeWalk(
      id, (rowId) => ctx.tx.get(rowId), isFieldDefinition, subtreeMemo,
    ),
    isProspectiveFieldRow: (row) => {
      if (row.parentId === null) return false
      // The id-carrying whole-block forms (`((id))`, `[label](((id)))`,
      // marked or not — §7) resolve textually, so this sync probe covers
      // them completely. A `[[name]]` whole-block ref needs the async alias
      // lookup this same-tx probe can't do — post-derive recognition
      // (`isPropertyFieldInstance`) covers those via the column (mirrors
      // `TxImpl.isProspectiveFieldRow`).
      const exact = parseExactReferenceBlockContent(row.content)
      if (exact === null || exact.kind === 'alias') return false
      return isFieldDefinition(exact.id)
    },
  }
}

// ─── children → cell (project) ───────────────────────────────────────────

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
  lookups: PropertyChildrenLookups,
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
  row: BlockData | null,
  lookups: PropertyChildrenLookups,
): Promise<void> => {
  if (row === null) return
  addAffectedProjection(out, row.parentId, getPropertyFieldTargetId(row), lookups)

  if (row.parentId === null) return
  const parent = await tx.get(row.parentId)
  if (parent === null || parent.parentId === null) return
  addAffectedProjection(out, parent.parentId, getPropertyFieldTargetId(parent), lookups)
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
    const values = await tx.childrenOf(fieldRow.id, undefined)
    for (const value of values) {
      try {
        return propertyChildContentToEncodedValue(
          schema, value.content, value.referenceTargetId ?? null,
        )
      } catch {
        // Invalid child text should not preserve a stale parent cell
        // projection. Skip it; if no child under this field parses, the
        // parent property is removed below.
      }
    }
  }
  return undefined
}

const fieldRowsForSchema = (
  children: readonly BlockData[],
  fieldId: string,
): BlockData[] => children.filter(child => getPropertyFieldTargetId(child) === fieldId)

const reprojectParentField = async (
  tx: Tx,
  affected: AffectedProjection,
  lookups: PropertyChildrenLookups,
): Promise<void> => {
  const schema = lookups.resolveFieldSchema(affected.fieldId)
  if (!schema) return

  const parent = await tx.get(affected.parentId)
  if (parent === null || parent.deleted) return
  // §9 positional rule: only CONTENT blocks host field rows. A ref-typed
  // VALUE child pointing at a definition looks exactly like a field row of
  // its (interior) parent — projecting there would parse its comments as
  // property values and write a junk key into a synced cell.
  if (await lookups.isInsidePropertySubtree(parent.id)) return

  const children = await tx.childrenOf(affected.parentId, undefined)
  const fieldRows = fieldRowsForSchema(children, affected.fieldId)
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

// ─── cell → children (materialize) ───────────────────────────────────────

const hasOwn = (properties: Record<string, unknown>, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(properties, name)

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

/** Find-or-create/update/delete the field+value children for `names` on
 *  `row` from its cell values. Exported for slice C's one-time backfill,
 *  which points the same convergence at whole workspaces. */
export const materializePropertyChildrenForExistingRow = async (
  tx: Tx,
  row: BlockData,
  lookups: PropertyChildrenLookups,
  names: readonly string[] = Object.keys(row.properties),
): Promise<void> => {
  if (row.deleted) return
  if (names.length === 0) return

  const children = await tx.childrenOf(row.id, undefined)

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
      throw new Error(
        `Cannot materialize property "${name}" on block ${row.id}: its cell ` +
        `value does not decode under the "${schema.codec.type}" codec. Write ` +
        `property values through tx.setProperty / block.set, not a raw ` +
        `tx.update({properties}).`,
        {cause},
      )
    }

    const content = encodedPropertyValueToChildContent(schema, encoded)
    const [primary, ...duplicates] = matchingChildren
    if (primary) {
      const fieldContent = propertyFieldContent(schema.fieldId)
      if (primary.content !== fieldContent) {
        await tx.update(primary.id, {content: fieldContent})
      }
      const values = await tx.childrenOf(primary.id, undefined)
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
        referenceTargetId: schema.fieldId,
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

const materializePropertiesForChangedRow = async (
  tx: Tx,
  row: {before: BlockData | null; after: BlockData | null},
  lookups: PropertyChildrenLookups,
): Promise<void> => {
  if (row.after === null || row.after.deleted) return
  // §9 positional rule: field rows and property-subtree interiors never
  // grow NESTED field rows — a bag write on a field/value row (e.g. a
  // UiState prop like system:collapsed once §6 migrates every scope) stays
  // cell-only there; recognition could never reclaim the nested rows.
  if (await lookups.isInsidePropertySubtree(row.after.id)) return
  // The walk above reads the STORED column — stale for a row whose content
  // was rewritten to `[[schema]]` earlier in this tx (this processor runs
  // BEFORE derive). Content-based twin of the same gate in tx.setProperty
  // (PR #386 review): a row about to be stamped as a field row must stay
  // cell-only, or we'd nest machinery it can never reclaim.
  if (lookups.isProspectiveFieldRow(row.after)) return
  const changedNames = changedPropertyNames(row.before?.properties ?? {}, row.after.properties)
  await materializePropertyChildrenForExistingRow(tx, row.after, lookups, changedNames)
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
  const duplicateValues = await tx.childrenOf(
    duplicate.id, undefined,
  )
  for (const value of duplicateValues) {
    const survivorValues = await tx.childrenOf(
      survivorFieldRowId, undefined,
    )
    const match = survivorValues.find(v => v.content === value.content)
    if (match) {
      await collapseDuplicateValueChild(tx, match.id, value)
    } else {
      const anchor = survivorValues.at(-1)?.orderKey ?? null
      await tx.move(value.id, {parentId: survivorFieldRowId, orderKey: keysBetween(anchor, null, 1)[0]!})
    }
  }
  await deleteSubtreeInTx(tx, duplicate.id)
}

// ─── processors ───────────────────────────────────────────────────────────

export const MATERIALIZE_PROPERTY_CHILDREN_PROCESSOR = defineSameTxProcessor({
  name: MATERIALIZE_PROPERTY_CHILDREN_PROCESSOR_NAME,
  watches: {kind: 'field', table: 'blocks', fields: ['properties']},
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
  watches: {kind: 'field', table: 'blocks', fields: ['content', 'referenceTargetId', 'parentId', 'orderKey', 'deleted']},
  // Issue #402: a plugin rewriting field/value-row content after this
  // ran (merge retarget on a value child or on a definition's field
  // rows, alias reverse-sync turning a child into `((fieldId))`,
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
    const lookups = lookupsFor(ctx, event.workspaceId)
    const affected = new Map<string, AffectedProjection>()
    for (const row of event.changedRows) {
      // Both sides of a move: the old parent loses the key, the new parent
      // gains it (§9 reparent semantics).
      await collectAffectedProjection(ctx.tx, affected, row.before, lookups)
      await collectAffectedProjection(ctx.tx, affected, row.after, lookups)
    }
    for (const projection of affected.values()) {
      await reprojectParentField(ctx.tx, projection, lookups)
    }
  },
})
