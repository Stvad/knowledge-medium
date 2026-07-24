/**
 * Same-tx property-definition RENAME (PR #288 §7/§9, PR #386 follow-up).
 *
 * A rename re-keys every consuming parent's cell (drop the old name, project
 * the new name from the field row's value) ATOMICALLY in the same tx that
 * edits the definition block's name — so the rename and its fan-out land as
 * ONE undoable step, not a deferred deep-idle batch (which was non-undoable,
 * had no completion marker, and captured a stale schema plan). This replaces
 * the rename half of `Repo.schedulePropertyDefinitionMigrations`; a codec-TYPE
 * change still rides that deferred path (it needs the NEW codec, which the
 * same-tx registry snapshot can't build).
 *
 * ── Two facts make this subtle ──
 *
 * 1. The registry snapshot the processor resolves against is frozen at TX
 *    START (`SameTxCtx`), so it still maps the OLD name → this definition and
 *    does NOT yet know the new name. That's fine — we read old/new name from
 *    the definition block's own before/after (`parsePropertyDefinitionMetadata`),
 *    and the codec is unchanged by a rename, so the tx-start schema
 *    (`resolvePropertySchemaField`) is the correct codec for reprojection.
 *
 * 2. Because the registry is stale in-tx, `MATERIALIZE_PROPERTY_CHILDREN`
 *    would still resolve the DROPPED old name to this definition and take its
 *    `encoded === undefined` DELETE branch — tombstoning the very field rows a
 *    rename must keep. The deferred batch dodged this only by running
 *    post-commit (registry already rebuilt → old name resolves to nothing).
 *    We dodge it by ORDERING: this processor runs LAST in
 *    `KERNEL_SAME_TX_PROCESSORS`, after MATERIALIZE/PROJECT, so the
 *    consuming-parent cell re-key it writes is never re-seen by MATERIALIZE in
 *    the same single-pass. (A later tx that touches such a parent sees a
 *    rebuilt registry where the old name resolves to nothing, so no delete.)
 *    The rename test asserts field rows SURVIVE.
 *
 * Synced-in renames don't run this pass (sync-apply is not `repo.tx`); they
 * are reconciled on the flipped-workspace open path (slice C / #389 item 2).
 * Flip-gated: dormant in a 'cell' workspace.
 */

import {
  defineSameTxProcessor,
  type AnyPropertySchema,
  type AnySameTxProcessor,
  type BlockData,
  type SameTxCtx,
} from '@/data/api'
import { parsePropertyDefinitionMetadata } from '@/data/propertyDefinitionMetadata'
import {
  isPropertyFieldInstance,
  propertyChildContentToEncodedValue,
  rekeyParentPropertyCell,
  type IsPropertyFieldDefinition,
} from '@/data/propertyChildren'

export const MIGRATE_PROPERTY_RENAME_PROCESSOR_NAME = 'core.migratePropertyRename'

interface RenamedDefinition {
  readonly fieldId: string
  readonly oldName: string
  readonly newName: string
  /** Tx-start schema for `fieldId` — OLD name, but the codec is unchanged by a
   *  rename, so it correctly decodes the field row's value for reprojection. */
  readonly schema: AnyPropertySchema
}

/** Definition blocks in `changedRows` whose NAME changed this tx. A brand-new
 *  definition (no `before`) has no existing consumer cells to re-key, and a
 *  shadowed/unavailable fieldId can't be reprojected — both are skipped, as is
 *  a rename onto a name a DIFFERENT non-renaming definition already owns. */
const collectRenames = (
  ctx: SameTxCtx,
  workspaceId: string,
  changedRows: ReadonlyArray<{before: BlockData | null; after: BlockData | null}>,
): RenamedDefinition[] => {
  // Pass 1: candidate renames (name changed, definition resolvable at tx start).
  const candidates: RenamedDefinition[] = []
  for (const {before, after} of changedRows) {
    if (after === null || after.deleted) continue
    const afterMeta = parsePropertyDefinitionMetadata(after)
    if (!afterMeta) continue
    const beforeMeta = before ? parsePropertyDefinitionMetadata(before) : null
    if (!beforeMeta || beforeMeta.name === afterMeta.name) continue
    const resolution = ctx.resolvePropertySchemaField(workspaceId, after.id)
    // A definition SHADOWED at tx start (two defs sharing a name, §6) resolves
    // as identity-unavailable here, so we skip it — its consuming cells stay
    // projected under the old name until the next value edit fires PROJECT (no
    // data loss: the id-addressed field row + value children are untouched).
    // Re-keying a shadowed def would need the tangled shadowing×projection
    // model that #389 item 8 owns, not a bolt-on here. (The OLD deferred batch
    // caught an *un-shadowing* rename via its schedule-time resolve; that
    // incidental coverage is intentionally traded for the same-tx undo
    // coherence, and folded into the #389 item-8 reconcile.)
    if (resolution.status !== 'resolved') continue
    candidates.push({
      fieldId: after.id,
      oldName: beforeMeta.name,
      newName: afterMeta.name,
      schema: resolution.schema,
    })
  }
  // Pass 2: drop a rename onto a COLLIDING new name. The tx-start resolver
  // still maps the renamed field under its OLD name, so it can't tell us who
  // wins the new name post-commit. If some OTHER definition already owns the
  // new name and is NOT itself renaming away from it, re-keying our value under
  // that name would overwrite that owner's cell projection with the wrong value
  // (found by Codex on PR #386) — the renamed field is likely shadowed there,
  // not the winner. Leave the whole re-key to the post-commit registry rebuild
  // + PROJECT / slice-C reconcile under the shadowing model (#389 item 8). A
  // SWAP (`a<->b`) is preserved: each new name is owned by a peer that IS
  // renaming away, so it isn't a real collision.
  const renamedFieldIds = new Set(candidates.map(c => c.fieldId))
  return candidates.filter(c => {
    const owner = ctx.resolvePropertySchemaName(workspaceId, c.newName)
    return !(
      owner.status === 'resolved'
      && owner.schema.fieldId !== c.fieldId
      && !renamedFieldIds.has(owner.schema.fieldId)
    )
  })
}

const consumingParentIds = async (
  ctx: SameTxCtx,
  workspaceId: string,
  fieldIds: readonly string[],
): Promise<string[]> => {
  // `parent_id IS NOT NULL`: a stamped workspace-root row is user content, not
  // a field row (§9 root half) — never re-key it.
  const rows = await ctx.db.getAll<{parent_id: string | null}>(
    `SELECT DISTINCT parent_id FROM blocks
      WHERE workspace_id = ? AND reference_target_id IN (${fieldIds.map(() => '?').join(', ')})
        AND deleted = 0 AND parent_id IS NOT NULL`,
    [workspaceId, ...fieldIds],
  )
  const set = new Set<string>()
  for (const row of rows) if (row.parent_id !== null) set.add(row.parent_id)
  return [...set]
}

/** Re-key one parent's cell for every rename that owns a field row under it.
 *  The shared `rekeyParentPropertyCell` owns the parent guard, the §9 ancestry
 *  gate, and the swap-safe drop-all-then-set-all apply; this supplies only the
 *  per-parent PLAN — project each renamed field's FIRST parseable value under
 *  the tx-start (rename-unchanged) codec, drop the old name, set the new. */
const rekeyParent = (
  ctx: SameTxCtx,
  parentId: string,
  renames: readonly RenamedDefinition[],
  isFieldDefinition: IsPropertyFieldDefinition,
  memo: Map<string, boolean>,
): Promise<void> =>
  rekeyParentPropertyCell(ctx.tx, parentId, isFieldDefinition, memo, async (siblings) => {
    const oldNames: string[] = []
    const assignments: Array<{name: string; value: unknown}> = []
    for (const rename of renames) {
      let projected: unknown
      let hasProjection = false
      let sawFieldRow = false
      for (const sibling of siblings) {
        if ((sibling.referenceTargetId ?? null) !== rename.fieldId) continue
        if (!isPropertyFieldInstance(sibling, isFieldDefinition)) continue
        sawFieldRow = true
        if (hasProjection) continue
        const values = await ctx.tx.childrenOf(sibling.id, undefined)
        for (const value of values) {
          try {
            projected = propertyChildContentToEncodedValue(
              rename.schema, value.content, value.referenceTargetId ?? null,
            )
            hasProjection = true
            break
          } catch {
            // Unparseable value — a rename doesn't change the codec, so this is a
            // pre-existing stale value; try the next, and if none parse the new
            // key stays unset (the old key is still dropped — §9: cell derives
            // from children, so a stale value shows unset until re-set).
          }
        }
      }
      if (!sawFieldRow) continue
      oldNames.push(rename.oldName)
      if (hasProjection) assignments.push({name: rename.newName, value: projected})
    }
    return {oldNames, assignments}
  })

export const MIGRATE_PROPERTY_RENAME_PROCESSOR = defineSameTxProcessor({
  name: MIGRATE_PROPERTY_RENAME_PROCESSOR_NAME,
  watches: {kind: 'field', table: 'blocks', fields: ['properties']},
  // settledWrites (issue #402): the consuming-cell re-keys this
  // processor writes must NOT mark rows dirty for the derivation
  // re-run pass. The re-run's MATERIALIZE resolves names against the
  // same stale tx-start registry described in fact 2 above — it would
  // read the dropped OLD name as a user's key deletion and tombstone
  // the field rows a rename must keep. The re-keys are already
  // convergent with the children by construction (they project FROM
  // the field rows), so suppressing re-derivation loses nothing.
  // Deliberately NOT rerunOnDirtyRows: a plugin renaming a definition
  // mid-pass has no reachable flow today, and a re-run against the
  // stale registry would only widen fact 2's blast radius.
  settledWrites: true,
  apply: async (event, ctx) => {
    if (!(await ctx.tx.isPropertyChildBackedWorkspace(event.workspaceId))) return
    const renames = collectRenames(ctx, event.workspaceId, event.changedRows)
    if (renames.length === 0) return
    const parentIds = await consumingParentIds(
      ctx, event.workspaceId, renames.map(r => r.fieldId),
    )
    if (parentIds.length === 0) return
    const isFieldDefinition: IsPropertyFieldDefinition = (fieldId) => {
      const resolution = ctx.resolvePropertySchemaField(event.workspaceId, fieldId)
      return resolution.status === 'resolved'
        || (resolution.status === 'identity-unavailable' && resolution.reason === 'shadowed')
    }
    const memo = new Map<string, boolean>()
    for (const parentId of parentIds) {
      await rekeyParent(ctx, parentId, renames, isFieldDefinition, memo)
    }
  },
})

export const propertyRenameSameTxProcessors: ReadonlyArray<AnySameTxProcessor> = [
  MIGRATE_PROPERTY_RENAME_PROCESSOR,
]
