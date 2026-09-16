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
 *    The registry is still what RECOGNIZES a field row (`reference_target_id`
 *    -> definition) and what says which definition owns a name, and both of
 *    those are answers about tx-start state, which is what they should be.
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
 * The same residual, reached a different way: a value preset whose `build`
 * starts returning a DIFFERENT codec type under the same preset id changes
 * every definition using it with no row edit at all, so nothing fires here.
 * That is already a frozen-identity violation — a preset id and its codec type
 * are keys user data is stored under (`seedIdentityLedger.ts`, #797) — and it
 * leaves exactly the cell-versus-children divergence the reconcile above
 * detects. Detecting it where it is DONE rather than sweeping for it
 * afterwards is #1022.
 *
 * Flip-gated: dormant in a 'cell' workspace.
 */

import { z } from 'zod'
import {
  definePostCommitProcessor,
  defineSameTxProcessor,
  ProcessorRejection,
  type AnyPropertySchema,
  type BlockData,
  type SameTxCtx,
} from '@/data/api'
import { parsePropertyDefinitionMetadata } from '@/data/propertyDefinitionMetadata'
import {
  deriveReferenceColumns,
  sameTxReferenceTargetLookups,
} from './referenceTargetProcessor'
import { tryBuildSchema } from '@/data/userSchemasService'
import {
  encodedPropertyValueToChildContent,
  isFieldValueChild,
  isPropertyFieldInstance,
  propertiesEqual,
  propertyChildContentToEncodedValue,
  type IsPropertyFieldDefinition,
} from '@/data/propertyChildren'

export const MIGRATE_PROPERTY_DEFINITION_PROCESSOR_NAME = 'core.migratePropertyDefinition'

export const REPORT_UNCONVERTIBLE_VALUES_PROCESSOR = 'core.reportPropertyCodecUnconvertible'

/**
 * Drop a rename whose OLD or NEW name a DIFFERENT definition owns and is not
 * itself vacating. Both halves protect a cell key that isn't this definition's
 * to write:
 *
 *  - NEW name: re-keying under a name someone else OWNS overwrites that owner's
 *    cell projection with the wrong value — the renamer is likely shadowed
 *    there, not the winner. The owner is the winner, so the head claimant
 *    settles it.
 *  - OLD name, and only when the candidate actually VACATES it: a rename
 *    un-shadows every definition that shared that name, so afterwards the name
 *    answers to a sibling — and dropping the key strands that sibling's cell
 *    until some unrelated edit reprojects it. The winner cannot answer this
 *    one: while the renamer still holds the name IT is the winner, so asking
 *    who owns the old name names the renamer itself and the refusal never
 *    fires. Every claimant has to be consulted. A codec-only change vacates
 *    nothing and is not subject to this half at all — it keeps the name it
 *    already wins, and a peer shadowed under that name is the status quo
 *    rather than something the change creates.
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
 * `claimantsOfName` answers from the TX-START registry, winner first, where a
 * peer owning the new name is one about to leave it. That is what makes the
 * drop-all-then-assign-all apply safe.
 */
export const withoutContestedRenames = <T extends {
  readonly fieldId: string
  readonly oldName: string
  readonly newName: string
}>(
  candidates: readonly T[],
  claimantsOfName: (name: string) => readonly string[],
): T[] => {
  let kept: T[] = [...candidates]
  for (;;) {
    const vacating = new Set(kept
      .filter(candidate => candidate.oldName !== candidate.newName)
      .map(candidate => candidate.fieldId))
    const free = (claimant: string | undefined, self: string): boolean =>
      claimant === undefined || claimant === self || vacating.has(claimant)
    const next = kept.filter(candidate => {
      if (!free(claimantsOfName(candidate.newName)[0], candidate.fieldId)) return false
      if (candidate.oldName === candidate.newName) return true
      return claimantsOfName(candidate.oldName)
        .every(claimant => free(claimant, candidate.fieldId))
    })
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
    // `after.deleted` is defence in depth — deleting a definition is its own
    // operation, and a tx that deletes without also editing the name or preset
    // stops at the no-change guard below.
    if (after === null || after.deleted || before === null) continue
    const afterMeta = parsePropertyDefinitionMetadata(after)
    const beforeMeta = parsePropertyDefinitionMetadata(before)
    if (!afterMeta || !beforeMeta) continue
    // A SEED's name and preset are code-owned and frozen once shipped
    // (`seedIdentityLedger.ts`), so a change to either across a build is a
    // deliberate migration (#797) rather than a user edit for this pass to fan
    // out. The materializer writes those rows under Automation scope, which
    // would otherwise reach this processor. Unpinned: reaching it needs a
    // shipped seed to change a frozen field, which the ledger test refuses
    // first — this keeps the exclusion the registry diff made before #1013,
    // rather than silently widening the pass to a path designed to be frozen.
    if (afterMeta.seedKey !== undefined) continue
    // There is deliberately no eligibility check for SHADOWING here. The
    // contested-name refusal below already covers both of its shapes from the
    // other side — a shadowed definition renaming away is refused because a
    // peer claims the name it vacates, and one re-typing in place is refused
    // because it is not the head claimant of the name it keeps — and asking the
    // resolver "does this fieldId resolve" instead would conflate shadowing
    // with having no buildable codec, which is the repair case below and must
    // NOT be skipped.
    const schema = tryBuildSchema(after, ctx.valuePresets, afterMeta)
    if (schema === null) continue
    // Read from the block's own rows, not from the registry: the tx-start
    // snapshot is at-or-older than `before`, so a codec change an earlier tx
    // already fanned out would read as this tx's and be re-encoded a second
    // time (idempotent, but it would re-report to the user).
    //
    // An unbuildable BEFORE row counts as changed. The old codec is what
    // DETECTS a change, never what performs one — the conversion parses the
    // child's TEXT under the new codec either way — so a definition whose
    // preset or config was broken and has now been repaired re-encodes on the
    // repairing tx, which is the only moment anything can. Re-parsing under an
    // unchanged codec is idempotent, so counting it costs nothing when the
    // repair restored the same type.
    const beforeSchema = tryBuildSchema(before, ctx.valuePresets, beforeMeta)
    const codecChanged = beforeSchema === null || beforeSchema.codec.type !== schema.codec.type
    // Every write to a definition block's bag reaches this processor —
    // MATERIALIZE's own field-row bookkeeping included. Without this, each one
    // would sweep every consumer of that definition inside the user's tx.
    if (beforeMeta.name === afterMeta.name && !codecChanged) continue
    candidates.push({
      fieldId: after.id,
      oldName: beforeMeta.name,
      newName: afterMeta.name,
      schema,
      codecChanged,
    })
  }
  // Pass 2: drop a rename onto a COLLIDING new name — see the refusal above.
  return withoutContestedRenames(candidates, (name) =>
    ctx.propertyDefinitionsClaimingName(workspaceId, name))
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

/** Apply every change that owns a field row under ONE parent, in one cell write.
 *
 *  SWAP-SAFE, and that is why the drops and the assignments are collected for
 *  EVERY change first and applied in two phases: with `a->b` and `b->a` in one
 *  tx, dropping and assigning per change in turn makes b's drop delete the key
 *  a just assigned, and one of the two values is gone. Two phases have no
 *  intermediate state at all — the swap lands as one write.
 *
 *  No ancestry gate (§9 flat recognition): ANY block owning recognized field
 *  rows — value rows and field rows included — re-keys like every other owner;
 *  its `::` children are its field rows at any depth. The write is
 *  `skipMetadata` machinery, not a "last edited" bump. */
const applyToParent = async (
  ctx: SameTxCtx,
  parentId: string,
  changes: readonly DefinitionChange[],
  isFieldDefinition: IsPropertyFieldDefinition,
  unconvertibleByField: Map<string, number>,
): Promise<void> => {
  const parent = await ctx.tx.get(parentId)
  // A soft-deleted parent can still own live field rows, so the query that
  // found it does not settle this. `tx.update` on a tombstone throws, which
  // would take the user's whole definition edit down with it.
  if (parent === null || parent.deleted) return
  const referenceLookups = sameTxReferenceTargetLookups(ctx.tx)
  const siblings = await ctx.tx.childrenOf(parentId, undefined)
  // Collected across EVERY change, then applied in two phases below — see the
  // swap note in this function's doc.
  const oldNames: string[] = []
  const assignments: Array<{name: string; value: unknown; unset: boolean}> = []
  for (const change of changes) {
    let projected: unknown
    let hasProjection = false
    let sawFieldRow = false
    let unconvertible = 0
    for (const sibling of siblings) {
      if ((sibling.referenceTargetId ?? null) !== change.fieldId) continue
      if (!isPropertyFieldInstance(sibling, isFieldDefinition)) continue
      sawFieldRow = true
      // §9 value set: bit-filtered — nested marked rows are machinery.
      const values = (await ctx.tx.childrenOf(sibling.id, undefined))
        .filter(isFieldValueChild)
      for (const value of values) {
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
        if (value.content === canonical) continue
        // Re-stamp the reference columns from the REWRITTEN content, the same
        // duty every same-tx processor that rewrites `content` after
        // `core.deriveReferenceTarget` already ran carries (merge retarget,
        // deleted-block inlining). Retyping a ref property to a text one turns
        // `((id))` into escaped plain text, and this processor's writes are
        // `settledWrites`, so the derive re-run will never revisit the row —
        // the column would keep naming a target the content no longer
        // references. Always an update of an existing row, so an unresolvable
        // alias clears the column rather than preserving a prior id.
        const derived = await deriveReferenceColumns(
          canonical, parent.workspaceId, referenceLookups,
        )
        const patch: Parameters<typeof ctx.tx.update>[1] = {content: canonical}
        const nextTargetId = derived.targetId ?? null
        if ((value.referenceTargetId ?? null) !== nextTargetId) {
          patch.referenceTargetId = nextTargetId
        }
        // Defence in depth, and kept so this stays the same two-column derive
        // every other inline re-stamp does: a VALUE child is bit-filtered out
        // of `isFieldValueChild` if it carries the field-form marker, so it
        // cannot be field-form before the rewrite, and escaping cannot make it
        // one afterwards.
        if ((value.isFieldForm ?? false) !== derived.isFieldForm) {
          patch.isFieldForm = derived.isFieldForm
        }
        await ctx.tx.update(value.id, patch, {skipMetadata: true})
      }
    }
    // This parent carries no field row for this definition, so its cell keys
    // for it are none of this change's business. Defence in depth: MATERIALIZE
    // gives every recognized key a field row, so a parent reached by the query
    // above normally has one for whichever change put it there.
    if (!sawFieldRow) continue
    if (change.codecChanged && unconvertible > 0) {
      unconvertibleByField.set(
        change.fieldId,
        (unconvertibleByField.get(change.fieldId) ?? 0) + unconvertible,
      )
    }
    if (change.oldName !== change.newName) oldNames.push(change.oldName)
    if (hasProjection) assignments.push({name: change.newName, value: projected, unset: false})
    else if (unconvertible === 0) {
      assignments.push({name: change.newName, value: undefined, unset: true})
    }
    // else (all-unconvertible): leave the new key as it is.
    //   - rename: the old key is dropped and the new key stays absent, so the
    //     cell shows unset for the unparseable values, §9's contract. Re-keying
    //     a stale value under the new name would violate §9 (cell derives from
    //     children).
    //   - no rename: the existing key rides untouched, so a stale-but-fixable
    //     value stays visible; the next valid edit reprojects and heals it
    //     (§5 pending-reprojection). Unsetting it instead costs the value rows:
    //     the name still resolves to this definition, so the next tx to touch
    //     this parent hands MATERIALIZE a missing key and it tombstones them as
    //     a user deletion.
    // This pass NEVER deletes value rows; the unconvertible COUNT is reported.
  }
  const next = {...parent.properties}
  for (const name of oldNames) delete next[name]
  for (const assignment of assignments) {
    if (assignment.unset) delete next[assignment.name]
    else next[assignment.name] = assignment.value
  }
  if (propertiesEqual(parent.properties, next)) return
  await ctx.tx.update(parentId, {properties: next}, {skipMetadata: true})
}

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
    // Defence in depth, and the cheap path for every workspace still on cells:
    // an un-flipped workspace has no field rows, so the query below already
    // finds no consumers.
    //
    // A re-type in a cell workspace is therefore NOT fanned out, and nothing
    // remembers it for after the flip. Declined deliberately, and measured
    // rather than reasoned: the flip materializes children FROM each cell and
    // skips any key whose cell value will not decode under the CURRENT codec,
    // reporting the block instead. So a value stranded by a re-type gets no
    // field row, and a post-flip re-encode — which walks field rows — would
    // have nothing to walk. The flip's own per-key report is the surface for
    // this, on both sides of #1013.
    if (!(await ctx.tx.isPropertyChildBackedWorkspace(event.workspaceId))) return
    const changes = collectChanges(ctx, event.workspaceId, event.changedRows)
    if (changes.length === 0) return
    const parentIds = await consumingParentIds(
      ctx, event.workspaceId, changes.map(c => c.fieldId),
    )
    if (parentIds.length === 0) return
    // This tx PARSED each changing definition's row, so its field rows are
    // recognized without asking the resolver — which would answer
    // `definition-unavailable` for exactly the one being repaired, and its
    // consumers are the ones the repair exists to reach. Every OTHER fieldId
    // encountered walking a parent's children is the resolver's to classify.
    const changing = new Set(changes.map(change => change.fieldId))
    const isFieldDefinition: IsPropertyFieldDefinition = (fieldId) => {
      if (changing.has(fieldId)) return true
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
