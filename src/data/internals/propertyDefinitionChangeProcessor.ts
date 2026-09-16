/**
 * Same-tx property-definition CHANGE — rename and codec-TYPE
 * (docs/properties-as-blocks-migration.html §7/§9).
 *
 * Editing a definition re-keys and re-encodes every consuming parent's cell
 * ATOMICALLY in the tx that edits the definition block, so the edit and its
 * fan-out land as ONE undoable step on the client that made it. Every other
 * client receives the finished rows by sync and does nothing. Nothing here is a
 * data migration: it writes only what the user's own edit implies, in the
 * user's own transaction, and is therefore not a one-shot pass — no claim, no
 * per-device baseline, no undo clearing (#1013).
 *
 * ── Three facts make this subtle ──
 *
 * 1. The registry snapshot the processor resolves against is frozen at TX START
 *    (`SameTxCtx`), so it still maps the OLD name to this definition and still
 *    carries the OLD codec. Both sides come from the definition block's own
 *    before/after instead: the name via `parsePropertyDefinitionMetadata`, the
 *    codec via `tryBuildSchema` over the staged row and `ctx.valuePresets` —
 *    which builds from the row plus the preset map and consults no registry.
 *    The registry answers exactly one question here: is this definition the
 *    workspace's winner for its name (a shadowed one is skipped).
 *
 * 2. Because the registry is stale in-tx, `MATERIALIZE_PROPERTY_CHILDREN` would
 *    still resolve the DROPPED old name to this definition and take its
 *    `encoded === undefined` DELETE branch — tombstoning the very field rows
 *    this pass must keep. We dodge it by ORDERING: this processor runs LAST in
 *    `KERNEL_SAME_TX_PROCESSORS`, after MATERIALIZE/PROJECT, so the writes it
 *    makes are never re-seen by MATERIALIZE in the same single pass. (A later
 *    tx sees a rebuilt registry where the old name resolves to nothing, so no
 *    delete.) A test asserts field rows SURVIVE.
 *
 * 3. Value children are re-encoded only when the codec TYPE changed, and their
 *    content is read under the NEW codec — the conversion IS "what does this
 *    text mean to the new type". What will not parse is counted and REPORTED
 *    (§9: "N values can't convert" must be user-visible, never a silent unset)
 *    and never deleted; the rows stay in the tree, fixable by hand.
 *
 * ── The accepted residual ──
 *
 * A device offline across the change, holding a block it created under the old
 * codec, is re-encoded by nobody — this runs on the initiating client only.
 * That is already the answer for renames, and the repair for both is the
 * content-driven reconcile that compares a cell against its field rows (#389
 * item 8), the only thing that can see such a row at all.
 *
 * Flip-gated: dormant in a 'cell' workspace.
 */

import { z } from 'zod'
import {
  definePostCommitProcessor,
  defineSameTxProcessor,
  ProcessorRejection,
  type AnyPostCommitProcessor,
  type AnyPropertySchema,
  type AnySameTxProcessor,
  type BlockData,
  type SameTxCtx,
} from '@/data/api'
import { parsePropertyDefinitionMetadata } from '@/data/propertyDefinitionMetadata'
import { tryBuildSchema } from '@/data/userSchemasService'
import {
  encodedPropertyValueToChildContent,
  isFieldValueChild,
  isPropertyFieldInstance,
  propertyChildContentToEncodedValue,
  rekeyParentPropertyCell,
  type IsPropertyFieldDefinition,
} from '@/data/propertyChildren'

export const MIGRATE_PROPERTY_DEFINITION_PROCESSOR_NAME = 'core.migratePropertyDefinition'

export const REPORT_UNCONVERTIBLE_VALUES_PROCESSOR = 'core.reportPropertyCodecUnconvertible'

/**
 * Drop a rename whose OLD or NEW name a DIFFERENT definition owns and is not
 * itself vacating. Both halves protect a cell key that isn't this definition's
 * to write:
 *
 *  - NEW name: re-keying under a name someone else owns overwrites that owner's
 *    cell projection with the wrong value — the renamer is likely shadowed
 *    there, not the winner.
 *  - OLD name: a rename UN-SHADOWS any definition that shared the old name, so
 *    afterwards that name answers to the sibling. Dropping it would strand the
 *    sibling's cell.
 *
 * Either way the contested case belongs to the shadowing model's own reconcile
 * (#389 item 8), not to a one-shot re-key.
 *
 * Two subtleties:
 *
 *  - Only a peer that CHANGES ITS NAME can vacate one. A codec-only change
 *    (`oldName === newName`) is in the same batch but keeps its name, so it
 *    must not grant the exemption.
 *  - Dropping a candidate can un-vacate the name that kept ANOTHER one, so this
 *    iterates to a fixpoint.
 *
 * `ownerOfName` answers from the TX-START registry, where a peer owning the new
 * name is one about to leave it. That is what makes the drop-all-then-set-all
 * apply in `rekeyParentPropertyCell` safe.
 */
export const withoutContestedRenames = <T extends {
  readonly fieldId: string
  readonly oldName: string
  readonly newName: string
}>(
  candidates: readonly T[],
  ownerOfName: (name: string) => string | undefined,
): T[] => {
  let kept: T[] = [...candidates]
  for (;;) {
    const vacating = new Set(kept
      .filter(candidate => candidate.oldName !== candidate.newName)
      .map(candidate => candidate.fieldId))
    const uncontested = (name: string, self: string): boolean => {
      const owner = ownerOfName(name)
      return owner === undefined || owner === self || vacating.has(owner)
    }
    const next = kept.filter(candidate =>
      uncontested(candidate.newName, candidate.fieldId)
      && uncontested(candidate.oldName, candidate.fieldId))
    if (next.length === kept.length) return next
    kept = next
  }
}

interface DefinitionChange {
  readonly fieldId: string
  readonly oldName: string
  readonly newName: string
  /** Schema built from the definition's AFTER row — the codec every value child
   *  is read under and the cell is projected with. For a pure rename that is
   *  the unchanged codec, which is exactly what reprojection needs. */
  readonly schema: AnyPropertySchema
  /** The codec TYPE changed in this tx. Only then is value-child CONTENT
   *  rewritten (a rename leaves the stored encoding alone), and only then is an
   *  unparseable value REPORTED — under an unchanged codec it is pre-existing
   *  staleness, not a consequence of this edit. */
  readonly codecChanged: boolean
}

/** Definition blocks in `changedRows` whose NAME or CODEC TYPE changed this tx.
 *  A brand-new definition (no `before`) has no existing consumer cells, and one
 *  whose after-row builds no codec cannot be reprojected — both are skipped, as
 *  is a rename onto a name a DIFFERENT non-renaming definition already owns. */
const collectChanges = (
  ctx: SameTxCtx,
  workspaceId: string,
  changedRows: ReadonlyArray<{before: BlockData | null; after: BlockData | null}>,
): DefinitionChange[] => {
  // Pass 1: candidate changes (name or codec differs, definition resolvable at
  // tx start, after-row buildable).
  const candidates: DefinitionChange[] = []
  for (const {before, after} of changedRows) {
    if (after === null || after.deleted || before === null) continue
    const afterMeta = parsePropertyDefinitionMetadata(after)
    const beforeMeta = parsePropertyDefinitionMetadata(before)
    if (!afterMeta || !beforeMeta) continue
    // A definition SHADOWED at tx start (two defs sharing a name, §6) resolves
    // as identity-unavailable here, so we skip it — its consuming cells stay
    // projected under the old name until the next value edit fires PROJECT (no
    // data loss: the id-addressed field row + value children are untouched).
    // Re-keying a shadowed def would need the tangled shadowing×projection
    // model that #389 item 8 owns, not a bolt-on here.
    if (ctx.resolvePropertySchemaField(workspaceId, after.id).status !== 'resolved') continue
    const schema = tryBuildSchema(after, ctx.valuePresets, afterMeta)
    if (schema === null) continue
    // Read from the block's own rows, not from the registry: the tx-start
    // snapshot is at-or-older than `before`, so a codec change an earlier tx
    // already fanned out would read as this tx's and be re-encoded a second
    // time (idempotent, but it would re-report to the user).
    const beforeSchema = tryBuildSchema(before, ctx.valuePresets, beforeMeta)
    const codecChanged = beforeSchema !== null && beforeSchema.codec.type !== schema.codec.type
    if (beforeMeta.name === afterMeta.name && !codecChanged) continue
    candidates.push({
      fieldId: after.id,
      oldName: beforeMeta.name,
      newName: afterMeta.name,
      schema,
      codecChanged,
    })
  }
  // Pass 2: drop a rename onto a COLLIDING new name — see the shared refusal.
  return withoutContestedRenames(candidates, (name) => {
    const owner = ctx.resolvePropertySchemaName(workspaceId, name)
    return owner.status === 'resolved' ? owner.schema.fieldId : undefined
  })
}

const consumingParentIds = async (
  ctx: SameTxCtx,
  workspaceId: string,
  fieldIds: readonly string[],
): Promise<string[]> => {
  // §9 selection discipline: field-row discovery keys on the BIT plus the
  // target (an unmarked `((fieldId))` link row is not a consumer), and
  // `parent_id IS NOT NULL` — a marked workspace-root row is user content,
  // not a field row (§9 root half) — never re-key it.
  const rows = await ctx.db.getAll<{parent_id: string | null}>(
    `SELECT DISTINCT parent_id FROM blocks
      WHERE workspace_id = ? AND reference_target_id IN (${fieldIds.map(() => '?').join(', ')})
        AND is_field_form = 1
        AND deleted = 0 AND parent_id IS NOT NULL`,
    [workspaceId, ...fieldIds],
  )
  const set = new Set<string>()
  for (const row of rows) if (row.parent_id !== null) set.add(row.parent_id)
  return [...set]
}

/** Apply every change that owns a field row under ONE parent. The shared
 *  `rekeyParentPropertyCell` owns the parent guard and the swap-safe
 *  drop-all-then-set-all apply; this supplies only the per-parent PLAN —
 *  re-encode the value children under the after-codec, project the first
 *  parseable one, drop the old name, set the new. */
const applyToParent = (
  ctx: SameTxCtx,
  parentId: string,
  changes: readonly DefinitionChange[],
  isFieldDefinition: IsPropertyFieldDefinition,
  unconvertibleByField: Map<string, number>,
): Promise<void> =>
  rekeyParentPropertyCell(ctx.tx, parentId, async (siblings) => {
    const oldNames: string[] = []
    const assignments: Array<{name: string; value: unknown; unset?: boolean}> = []
    for (const change of changes) {
      let projected: unknown
      let hasProjection = false
      let sawFieldRow = false
      // Unparseable value children. Complete when the codec changed (every
      // value is visited) or when nothing projected (the early exit below never
      // fired) — and those are the only two states it is read in.
      let unconvertible = 0
      for (const sibling of siblings) {
        if ((sibling.referenceTargetId ?? null) !== change.fieldId) continue
        if (!isPropertyFieldInstance(sibling, isFieldDefinition)) continue
        sawFieldRow = true
        // A rename is done with this definition once one value has projected: it
        // rewrites no content, so the rest are not its business. A codec change
        // must see every one of them — each is re-encoded, and the ones that
        // cannot convert are counted for the report below.
        if (hasProjection && !change.codecChanged) continue
        // §9 value set: bit-filtered — nested marked rows are machinery.
        const values = (await ctx.tx.childrenOf(sibling.id, undefined))
          .filter(isFieldValueChild)
        for (const value of values) {
          if (hasProjection && !change.codecChanged) break
          let encoded: unknown
          try {
            encoded = propertyChildContentToEncodedValue(change.schema, value.content)
          } catch {
            unconvertible += 1
            continue
          }
          if (!hasProjection) {
            projected = encoded
            hasProjection = true
          }
          if (!change.codecChanged) continue
          // Canonicalize the stored text under the new codec so it reads back as
          // what `setProperty` would have written.
          const canonical = encodedPropertyValueToChildContent(change.schema, encoded)
          if (value.content !== canonical) {
            await ctx.tx.update(value.id, {content: canonical}, {skipMetadata: true})
          }
        }
      }
      // This parent carries no field row for this definition — its cell keys
      // for it are none of this change's business.
      if (!sawFieldRow) continue
      if (change.codecChanged && unconvertible > 0) {
        unconvertibleByField.set(
          change.fieldId,
          (unconvertibleByField.get(change.fieldId) ?? 0) + unconvertible,
        )
      }
      if (change.oldName !== change.newName) oldNames.push(change.oldName)
      if (hasProjection) {
        assignments.push({name: change.newName, value: projected})
      } else if (unconvertible === 0) {
        assignments.push({name: change.newName, value: undefined, unset: true})
      }
      // else (all-unconvertible): leave the new key unset — no assignment.
      //   - rename: the old key is dropped and the new key stays absent, so the
      //     cell shows unset for the unparseable values, §9's contract. Re-keying
      //     a stale value under the new name would violate §9 (cell derives from
      //     children).
      //   - no rename: the existing key rides untouched, so a stale-but-fixable
      //     value stays visible; the next valid edit reprojects and heals it
      //     (§5 pending-reprojection). Unsetting it instead tombstones the value
      //     rows — MATERIALIZE reads the missing key as a user deletion (#800).
      // This pass NEVER deletes value rows; the unconvertible COUNT is reported.
    }
    return {oldNames, assignments}
  })

export const MIGRATE_PROPERTY_DEFINITION_PROCESSOR = defineSameTxProcessor({
  name: MIGRATE_PROPERTY_DEFINITION_PROCESSOR_NAME,
  watches: {kind: 'field', table: 'blocks', fields: ['properties']},
  // settledWrites (issue #402): the consuming-cell re-keys and value-child
  // re-encodes this processor writes must NOT mark rows dirty for the
  // derivation re-run pass. The re-run's MATERIALIZE resolves names against the
  // same stale tx-start registry described in fact 2 above — it would read the
  // dropped OLD name as a user's key deletion and tombstone the field rows this
  // pass must keep. Both writes are already convergent with the children by
  // construction (the cell is projected FROM them, the content is canonicalized
  // under the codec the cell was projected with), so suppressing re-derivation
  // loses nothing. Deliberately NOT rerunOnDirtyRows: a plugin editing a
  // definition mid-pass has no reachable flow today, and a re-run against the
  // stale registry would only widen fact 2's blast radius.
  settledWrites: true,
  apply: async (event, ctx) => {
    if (!(await ctx.tx.isPropertyChildBackedWorkspace(event.workspaceId))) return
    const changes = collectChanges(ctx, event.workspaceId, event.changedRows)
    if (changes.length === 0) return
    const parentIds = await consumingParentIds(
      ctx, event.workspaceId, changes.map(c => c.fieldId),
    )
    if (parentIds.length === 0) return
    const isFieldDefinition: IsPropertyFieldDefinition = (fieldId) => {
      const resolution = ctx.resolvePropertySchemaField(event.workspaceId, fieldId)
      return resolution.status === 'resolved'
        || (resolution.status === 'identity-unavailable' && resolution.reason === 'shadowed')
    }
    const unconvertibleByField = new Map<string, number>()
    for (const parentId of parentIds) {
      await applyToParent(ctx, parentId, changes, isFieldDefinition, unconvertibleByField)
    }
    // Reported per definition, after commit: one edit can re-type several, and a
    // tx that rolls back stranded nothing. `afterCommit` is the only channel a
    // same-tx processor has to say something non-fatal — a throw would revert
    // the user's own edit.
    for (const change of changes) {
      const count = unconvertibleByField.get(change.fieldId) ?? 0
      if (count === 0) continue
      ctx.tx.afterCommit(REPORT_UNCONVERTIBLE_VALUES_PROCESSOR, {
        fieldId: change.fieldId, name: change.newName, count,
      })
    }
  },
})

interface UnconvertibleArgs {
  fieldId: string
  name: string
  count: number
}

const unconvertibleArgsSchema = z.object({
  fieldId: z.string(),
  name: z.string(),
  count: z.number(),
})

declare module '@/data/api' {
  interface PostCommitProcessorRegistry {
    [REPORT_UNCONVERTIBLE_VALUES_PROCESSOR]: UnconvertibleArgs
  }
}

export const REPORT_UNCONVERTIBLE_VALUES = definePostCommitProcessor<UnconvertibleArgs>({
  name: REPORT_UNCONVERTIBLE_VALUES_PROCESSOR,
  watches: {kind: 'explicit'},
  scheduledArgsSchema: unconvertibleArgsSchema,
  apply: async (event, ctx) => {
    const args = event.scheduledArgs
    if (!args || args.count <= 0) return
    // Claim only what's true: this pass never deletes a value row, so the text
    // is preserved verbatim. It does NOT promise a surface — value children sit
    // under a field row, and the visible view prunes field rows (§9), so they
    // are reachable through the property rows, not by scrolling the outline.
    const message =
      `${args.count} value${args.count === 1 ? '' : 's'} for property `
      + `"${args.name}" could not convert to the new type; their original `
      + `text is preserved unchanged`
    console.warn(`[propertyDefinitionChange] ${message}`)
    ctx.repo.reportUserError(new ProcessorRejection(
      message, 'property.codec-change.unconvertible',
      {fieldId: args.fieldId, name: args.name, count: args.count},
    ))
  },
})

export const propertyDefinitionSameTxProcessors: ReadonlyArray<AnySameTxProcessor> = [
  MIGRATE_PROPERTY_DEFINITION_PROCESSOR,
]

export const propertyDefinitionPostCommitProcessors: ReadonlyArray<AnyPostCommitProcessor> = [
  REPORT_UNCONVERTIBLE_VALUES,
]
