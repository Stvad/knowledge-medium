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
 * And a third: a re-type in a workspace that genuinely has no field rows yet
 * fans nothing out, and nothing remembers it for after the flip. Measured
 * rather than reasoned: the flip materializes children FROM each cell and skips
 * any key whose cell value will not decode under the CURRENT codec, reporting
 * the block instead — so a value stranded by such a re-type gets no field row,
 * and a pass that walks field rows would have nothing to walk. The flip's own
 * per-key report is the surface for it.
 *
 * Dormant until a definition has field rows — see `consumingParentIds`, which
 * is the gate.
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
import { presetConfigProp, presetIdProp } from '@/data/properties'
import { peekRowProperty } from '@/data/rowProperty'
import { jsonValuesEqual } from './jsonCanonical'
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

/** The definition a row described BEFORE this tx, tombstone included.
 *
 *  `parsePropertyDefinitionMetadata` refuses a deleted row, which is right
 *  everywhere else — a tombstone publishes nothing, so it claims no name and
 *  the registry does not list it. But a definition being REVIVED still has
 *  consumers whose cells are keyed under the name in that bag and whose values
 *  are encoded under its preset, and those are exactly what the fan-out needs
 *  to re-key and re-encode from. Restoring and re-typing in one tx is otherwise
 *  skipped entirely, leaving every consumer in the old encoding while the
 *  rebuilt registry publishes the new codec. */
const definitionAsOfBefore = (
  row: BlockData,
): ReturnType<typeof parsePropertyDefinitionMetadata> =>
  parsePropertyDefinitionMetadata(row.deleted ? {...row, deleted: false} : row)

/** Did anything the codec is BUILT FROM change?
 *
 *  `tryBuildSchema` derives a codec from exactly two properties of the row — the
 *  preset id and the preset config — so comparing those answers the question
 *  exactly, where every observable derived from the codec only approximates it.
 *  Three review rounds went to that approximation: `codec.type` cannot tell
 *  `optional-string` from `string` (they report the same one), a preset id alone
 *  cannot see a configurable preset whose `build(config)` returns a different
 *  codec, and the two together still miss a config edit that moves between
 *  codecs SHARING a type. The inputs have no such blind spot.
 *
 *  Wider than the registry diff this replaced, which treated a config edit as no
 *  change. The extra cost is re-parsing a property's value children on a config
 *  edit that did not move the encoding — which writes nothing, since
 *  `value.content !== canonical` guards it, and reports nothing, because a codec
 *  that reads leniently across such an edit (enum keeping a value whose option
 *  was removed) decodes it successfully and is never counted. */
const codecInputsChanged = (before: BlockData, after: BlockData): boolean =>
  peekRowProperty(before, presetIdProp) !== peekRowProperty(after, presetIdProp)
  || !jsonValuesEqual(
    peekRowProperty(before, presetConfigProp),
    peekRowProperty(after, presetConfigProp),
  )

/** `tryBuildSchema` answers `null` for a preset it cannot find or configure, but
 *  `preset.build` is extension code and can THROW. The projector already treats
 *  that as "no behaviour" and publishes metadata only; here an escape would
 *  abort the USER'S transaction — and for a definition whose preset throws, the
 *  transaction it would abort is the one repairing it. Same answer as null. Not
 *  logged: the projector warns for the same row on its own rebuild. */
const buildSchemaOrNull = (
  row: BlockData,
  presets: SameTxCtx['valuePresets'],
  metadata: NonNullable<ReturnType<typeof parsePropertyDefinitionMetadata>>,
): AnyPropertySchema | null => {
  try {
    return tryBuildSchema(row, presets, metadata)
  } catch {
    return null
  }
}

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
/**
 * Drop a rename or re-type whose destination, or whose vacated name, is not
 * this definition's to write.
 *
 * `claimOf` answers who holds a name once THIS TX COMMITS. Six review rounds
 * went into that answer, each finding another source it was missing, so it is
 * derived from the ROWS rather than accumulated: definitions the tx deletes,
 * revives, creates, renames or strips of their metadata all move a name, and
 * none of them appears in the tx-start registry under the name it ends up with.
 *
 * The decisive correction, and the reason nothing here is derived from which
 * candidates SURVIVE: dropping a candidate suppresses its FAN-OUT, never its
 * definition row. The rename commits either way. A model that treated a dropped
 * rename as not having happened re-contested names it really did vacate, and
 * cascaded — refusing one fan-out made the refusal refuse the next.
 *
 * So both halves read a post-commit claim that does not depend on this
 * function's own outcome:
 *
 *  - The DESTINATION is contested when anyone ELSE holds it after commit, or
 *    when anyone else ARRIVES at it. Two definitions landing on one key means
 *    the later write wins a race the rebuilt registry may decide the other way,
 *    and that is true whether the peer's own fan-out was kept or dropped.
 *  - The name being VACATED is contested when anyone else will hold it whose
 *    cells this pass does NOT fix. Whoever inherits the key this rename drops
 *    is stranded by it — unless they are a kept candidate, whose own fan-out
 *    projects them under that name in this same tx. That exemption is the one
 *    thing here that depends on the outcome, which is why this still iterates
 *    to a fixpoint: dropping a candidate can strand whoever was relying on it.
 *
 * `null` is not "nobody claims it" — it is a workspace with no registry, where
 * nothing can be judged. The caller refuses the transaction rather than
 * committing a definition change it cannot fan out.
 *
 * A candidate dropped here belongs to the shadowing model's own reconcile
 * (#389 item 8), not to a one-shot re-key.
 *
 * WHAT NONE OF THIS REACHES: a name's cells outlive the definition that owned
 * it. Every way of leaving a name — a refused rename, an unbuildable one, a
 * deletion, losing the definition metadata — leaves that definition's consumers
 * keyed under it, because the fan-out only visits consumers of definitions
 * whose own fan-out was kept. Whoever takes the name next then reads those
 * values through its own schema. Contesting the name does not repair them and
 * strands the arriving definition's consumers as well; the choices that do are
 * a reconcile, a refusal, or retiring the departing definition's cells, and
 * picking between them is #1028.
 */
export interface NameClaim {
  /** Definitions that will STILL hold this name once the tx commits, winner
   *  first — the tx-start claimants minus any the tx moves off it. The head is
   *  the one that projects, so an owner that leaves hands that role on. */
  readonly holding: readonly string[]
  /** Definitions that will NEWLY hold it: created, revived, or renamed onto it.
   *  Renames whose fan-out this refusal drops are included — suppressing a
   *  re-key does not cancel the row's name change. */
  readonly arriving: readonly string[]
}

export const withoutContestedRenames = <T extends {
  readonly fieldId: string
  readonly oldName: string
  readonly newName: string
}>(
  candidates: readonly T[],
  claimOf: (name: string) => NameClaim | null,
): T[] => {
  let kept: T[] = [...candidates]
  for (;;) {
    const keptIds = new Set(kept.map(candidate => candidate.fieldId))
    const next = kept.filter(candidate => {
      const destination = claimOf(candidate.newName)
      if (destination === null) return false
      const owner = destination.holding[0]
      if (owner !== undefined && owner !== candidate.fieldId) return false
      if (destination.arriving.some(peer => peer !== candidate.fieldId)) return false
      if (candidate.oldName === candidate.newName) return true
      const vacated = claimOf(candidate.oldName)
      if (vacated === null) return false
      // A kept candidate inheriting this name re-keys its own consumers under
      // it in this same tx, so it is not stranded by the drop. Anyone else is.
      return [...vacated.holding, ...vacated.arriving]
        .every(peer => peer === candidate.fieldId || keptIds.has(peer))
    })
    if (next.length === kept.length) return next
    kept = next
  }
}

type CollectedChanges =
  | 'unjudgeable'
  | {
      readonly changes: DefinitionChange[]
      /** Definitions RENAMED in this tx whose rows build no codec on either
       *  side, so the fan-out cannot reproject their consumers' cells. */
      readonly unbuildableRenames: readonly string[]
    }

interface DefinitionChange {
  readonly fieldId: string
  readonly oldName: string
  readonly newName: string
  /** The codec every value child is read under and the cell is projected with.
   *  The AFTER row's, except when that row builds none — a rename that also
   *  switched to a missing, invalid or throwing preset still has to re-key, and
   *  the values are still in the BEFORE row's encoding, which makes its codec
   *  the right one to reproject them with. */
  readonly schema: AnyPropertySchema
  /** The stored ENCODING may now differ, so value-child content is rewritten
   *  and anything that will not parse is REPORTED. False for a pure rename,
   *  where the encoding is untouched and an unparseable value is pre-existing
   *  staleness rather than a consequence of this edit — and false when the
   *  after-row builds no codec, since nothing can be re-encoded into one that
   *  does not exist; the transaction repairing the preset picks that up. */
  readonly encodingChanged: boolean
}

/** Definition blocks in `changedRows` whose NAME or CODEC TYPE changed this tx.
 *  A brand-new definition (no `before`) has no existing consumer cells, and one
 *  whose after-row builds no codec cannot be reprojected — both are skipped, as
 *  is a rename onto a name a DIFFERENT non-renaming definition already owns. */
const collectChanges = (
  ctx: SameTxCtx,
  workspaceId: string,
  changedRows: ReadonlyArray<{before: BlockData | null; after: BlockData | null}>,
): CollectedChanges => {
  // Pass 1: candidate changes (name or encoding differs, some row buildable).
  const candidates: DefinitionChange[] = []
  const unbuildableRenames: string[] = []
  /** Any name this tx touches — enough to ask whether the WORKSPACE can be
   *  judged at all, which is not a question about the name. */
  let probeName: string | null = null
  for (const {before, after} of changedRows) {
    // `after.deleted` is defence in depth — deleting a definition is its own
    // operation, and a tx that deletes without also editing the name or preset
    // stops at the no-change guard below.
    if (after === null || after.deleted || before === null) continue
    const afterMeta = parsePropertyDefinitionMetadata(after)
    const beforeMeta = definitionAsOfBefore(before)
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
    const afterSchema = buildSchemaOrNull(after, ctx.valuePresets, afterMeta)
    const beforeSchema = buildSchemaOrNull(before, ctx.valuePresets, beforeMeta)
    const schema = afterSchema ?? beforeSchema
    if (schema === null) {
      // NEITHER row builds a codec, so there is nothing to reproject a cell
      // with. A rename here cannot be dropped silently: consumers keep the old
      // key, and the transaction that eventually repairs the preset cannot
      // remove it, because by then both sides carry the new name. Held for the
      // caller, which refuses the tx if any of these actually has consumers.
      if (beforeMeta.name !== afterMeta.name) {
        unbuildableRenames.push(after.id)
        probeName ??= afterMeta.name
      }
      continue
    }
    // The PRESET is the discriminator, not `codec.type`. A codec's type string
    // is not its identity: `optional-string` and `string` both report 'string'
    // while the optional one stores an unset value as `null`, which the
    // required one reads back as literal text — so switching between twins
    // changes the stored encoding without changing the type, and the
    // seed-identity rules freeze preset AND codec for exactly that reason.
    // Compared by the codec's INPUTS rather than by anything derived from the
    // codec it built — see `codecInputsChanged`.
    //
    // Read from the block's own rows, not from the registry: the tx-start
    // snapshot is at-or-older than `before`, so a change an earlier tx already
    // fanned out would read as this tx's and be re-encoded a second time
    // (idempotent, but it would re-report to the user).
    //
    // An unbuildable BEFORE row counts as changed. The old codec is what
    // DETECTS a change, never what performs one — the conversion parses the
    // child's TEXT under the new codec either way — so a definition whose
    // preset or config was broken and has now been repaired re-encodes on the
    // repairing tx, which is the only moment anything can.
    // A REVIVAL counts as changed whatever the two bags say. A tombstone can be
    // edited — by sync, or by a script — and a later plain `tx.restore` then
    // presents identical before/after bags that both describe the POST-edit
    // preset, while the consumers are still in the pre-delete encoding. Nothing
    // on the row remembers that encoding once the bag has moved, so the
    // revival, which is when the registry starts publishing the new codec
    // again, is the only moment anything can reconcile them. Re-parsing under
    // an unchanged codec is idempotent, so a plain restore of an untouched
    // definition writes nothing.
    const revived = before.deleted === true
    const encodingChanged = afterSchema !== null && (
      beforeSchema === null || revived || codecInputsChanged(before, after)
    )
    // Every write to a definition block's bag reaches this processor —
    // MATERIALIZE's own field-row bookkeeping included. Without this, each one
    // would sweep every consumer of that definition inside the user's tx.
    if (beforeMeta.name === afterMeta.name && !encodingChanged) continue
    probeName ??= afterMeta.name
    candidates.push({
      fieldId: after.id,
      oldName: beforeMeta.name,
      newName: afterMeta.name,
      schema,
      encodingChanged,
    })
  }
  if (candidates.length === 0 && unbuildableRenames.length === 0) {
    return {changes: [], unbuildableRenames}
  }
  // Every definition this tx leaves live under a name it did NOT hold at tx
  // start. The registry lists none of them: a created row has no entry, a
  // revived one lost its entry when it was tombstoned, and a renamed one is
  // still filed under its old name. A revived or created claimant never becomes
  // a candidate either — nothing about its own name changed — so this is the
  // only place it can be seen.
  // ONE derivation of what this tx does to names, read off the ROWS. Every
  // definition it touches either keeps the name the tx-start registry files it
  // under, or leaves it — by being deleted, renamed, or stripped of the
  // metadata that made it a definition at all — and may land on a new one.
  // Neither list depends on which fan-outs the refusal keeps, because a dropped
  // fan-out still commits its row: see the refusal's own doc.
  const released = new Set<string>()
  const arrivingByName = new Map<string, string[]>()
  for (const {before, after} of changedRows) {
    const beforeMeta = before !== null && !before.deleted
      ? parsePropertyDefinitionMetadata(before)
      : null
    const afterMeta = after !== null && !after.deleted
      ? parsePropertyDefinitionMetadata(after)
      : null
    if (beforeMeta === null && afterMeta === null) continue
    const keepsItsName = beforeMeta !== null && afterMeta !== null
      && beforeMeta.name === afterMeta.name
    if (keepsItsName) continue
    if (beforeMeta !== null) released.add(before!.id)
    if (afterMeta !== null) {
      const arriving = arrivingByName.get(afterMeta.name) ?? []
      arriving.push(after!.id)
      arrivingByName.set(afterMeta.name, arriving)
    }
  }
  if (ctx.propertyDefinitionsClaimingName(workspaceId, probeName!) === null) {
    return 'unjudgeable'
  }
  // Pass 2: drop a rename whose destination or vacated name is contested — see
  // the refusal above for how the two halves differ.
  return {
    changes: withoutContestedRenames(candidates, (name) => {
      const atTxStart = ctx.propertyDefinitionsClaimingName(workspaceId, name)
      return atTxStart === null
        ? null
        : {
          holding: atTxStart.filter(fieldId => !released.has(fieldId)),
          arriving: arrivingByName.get(name) ?? [],
        }
    }),
    unbuildableRenames,
  }
}

/** One bound variable per changed definition would blow
 *  SQLITE_MAX_VARIABLE_NUMBER on a scripted transaction that edits a whole
 *  registry's worth of them — and this probe runs INSIDE the user's tx, so the
 *  throw takes their entire edit down rather than costing a deferred pass a
 *  retry the way it used to. */
export const FIELD_PROBE_CHUNK = 500

/** Parents holding a live field row for any of `fieldIds` — and the only gate
 *  this pass has.
 *
 *  Deliberately NOT `isPropertyChildBackedWorkspace`. That flag lives on the
 *  workspace ROW, which syncs like any other, so a device lagging on it reads
 *  `cell` for a graph another device already flipped and materialized — and
 *  would skip a fan-out whose field rows it is holding, uploading a re-typed
 *  definition that its child-backed peers then read old encodings through. The
 *  flag was only ever a cheap proxy for this query, which asks the rows
 *  themselves and cannot be stale about rows this device has.
 *
 *  Field rows only, which means a parent the cell-to-children backfill has not
 *  reached yet is NOT a consumer here. The runbook flips before backfilling, so
 *  that window is real and a definition edit inside it strands those cells
 *  permanently — #1029, and the same blind spot the pass this replaced had.
 *
 *  The Set is load-bearing across chunks, not tidiness:
 *  `SELECT DISTINCT` dedupes only WITHIN one statement, so a parent consuming
 *  two changed definitions that land in different chunks would otherwise be
 *  visited — and re-keyed — twice. */
export const consumingParentIds = async (
  db: Pick<SameTxCtx['db'], 'getAll'>,
  workspaceId: string,
  fieldIds: readonly string[],
  chunkSize = FIELD_PROBE_CHUNK,
): Promise<string[]> => {
  const set = new Set<string>()
  for (let i = 0; i < fieldIds.length; i += chunkSize) {
    const chunk = fieldIds.slice(i, i + chunkSize)
    // §9 selection discipline: field-row discovery keys on the BIT plus the
    // target (an unmarked `((fieldId))` link row is not a consumer), and
    // `parent_id IS NOT NULL` — a marked workspace-root row is user content,
    // not a field row (§9 root half) — never re-key it.
    const rows = await db.getAll<{parent_id: string | null}>(
      `SELECT DISTINCT parent_id FROM blocks
        WHERE workspace_id = ? AND reference_target_id IN (${chunk.map(() => '?').join(', ')})
          AND is_field_form = 1
          AND deleted = 0 AND parent_id IS NOT NULL`,
      [workspaceId, ...chunk],
    )
    for (const row of rows) if (row.parent_id !== null) set.add(row.parent_id)
  }
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
  // found it does return one. Skipped by choice, not by necessity — `tx.update`
  // accepts a tombstone: a deleted block's bag is history, and the live set is
  // bounded by current usage while the tombstoned set is bounded by ALL-TIME
  // usage, so re-keying it would put an unbounded write in the user's own
  // transaction. The cost is that restoring such a block revives it under the
  // old key; #1023 fixes that where it belongs, at restore.
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
        if (!change.encodingChanged) continue
        // Canonicalize the stored text under the new codec so it reads back as
        // what `setProperty` would have written. Re-parsing the TEXT is what
        // makes a cross-type conversion possible at all, and it costs one
        // ambiguity: a bare `null` is a literal to a codec that rejects null
        // and the unset sentinel to one that accepts it (#1030).
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
    if (change.encodingChanged && unconvertible > 0) {
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
  // `deleted` as well as `properties`, because the claim model in
  // `collectChanges` has to see definitions this tx REMOVES or REVIVES, and
  // neither touches the bag. The field watch compares by VALUE, so a
  // `tx.restore` that rewrites an identical properties_json does not register
  // as a properties change at all. Ordinary block deletes now reach this
  // processor and stop at the first metadata parse, before any query.
  watches: {kind: 'field', table: 'blocks', fields: ['properties', 'deleted']},
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
    const collected = collectChanges(ctx, event.workspaceId, event.changedRows)
    if (collected === 'unjudgeable') {
      // Refuse the whole tx rather than commit half of it. `repo.tx` surfaces a
      // ProcessorRejection to the toast layer and rolls back, so the definition
      // row does not land either — which is the point: a re-typed definition
      // whose consumers were never re-encoded has no repair path left, and a
      // client with no registry for this workspace cannot recognize its field
      // rows or judge its names well enough to provide one.
      throw new ProcessorRejection(
        'cannot edit a property definition in a workspace this client has no '
        + 'definition registry for: its consuming blocks could not be updated '
        + 'to match. Open that workspace and try again.',
        'property.definition-change.unjudgeable',
        {workspaceId: event.workspaceId},
      )
    }
    const {changes, unbuildableRenames} = collected
    if (unbuildableRenames.length > 0) {
      // Only a rename with CONSUMERS strands anything; one on an unused
      // definition is the user's to make, and telling them to repair a preset
      // first would be friction for nothing.
      const stranded = await consumingParentIds(
        ctx.db, event.workspaceId, unbuildableRenames,
      )
      if (stranded.length > 0) {
        throw new ProcessorRejection(
          'cannot rename a property definition whose value type does not load: '
          + 'the blocks using it could not be updated to the new name. Fix the '
          + 'property type first, then rename.',
          'property.definition-rename.unbuildable',
          {fieldIds: [...unbuildableRenames]},
        )
      }
    }
    if (changes.length === 0) return
    const parentIds = await consumingParentIds(
      ctx.db, event.workspaceId, changes.map(c => c.fieldId),
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
