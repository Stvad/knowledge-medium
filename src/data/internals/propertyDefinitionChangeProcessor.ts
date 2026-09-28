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
 * 3. Value children are re-encoded when the codec's INPUTS changed — the
 *    definition row's preset id and preset config, NOT the built codec's type
 *    string, which cannot tell `optional-string` from `string`
 *    (`codecInputsChanged`). `convertValueChildContent` owns which reading of
 *    a value child wins. Whether the edit TAKES A VALUE AWAY is a separate
 *    question, `valuesLostBy`'s, at cell grain — rows that re-spell to the
 *    same text fold into one, and a narrowing to a scalar keeps only the
 *    first that parses, neither of which is a row failing to convert. Either
 *    way the transaction is REFUSED — §9's "N values can't convert" is
 *    user-visible here as the reason the change did not happen, which is the
 *    only form of it that keeps the value. A value already unreadable before
 *    the edit blocks nothing: the cell never held it.
 *
 * ── The accepted residuals ──
 *
 * Ways a consumer is left in the old encoding, all of them the same shape — a
 * change this processor is not present for. The first three are repaired by
 * the content-driven reconcile that compares a cell against its field rows
 * (#389 item 8), the only thing that can see such a row; the fourth is not,
 * and says why:
 *
 *  - a device offline across the change, holding a block whose value row it
 *    edited under the old codec. This runs on the initiating client only,
 *    which is already the answer for renames.
 *  - a value preset whose `build` starts returning a different codec under the
 *    same preset id: no row edit at all, so nothing fires. Already a
 *    frozen-identity violation (`seedIdentityLedger.ts`, #797). Caught where it
 *    is DONE instead: the ledger's test for a code-owned core, and for a core a
 *    runtime extension registers, the install-time refusal in
 *    `@/plugins/agent-runtime/presetIdentity` (#1022) — which sees the change
 *    only while the core it replaces is registered on that device, so an
 *    extension re-installed while not running still lands here.
 *  - a re-type in a workspace with no field rows yet, which fans nothing out
 *    and is remembered by nothing for after the flip. The flip skips any key
 *    whose cell will not decode under the current codec and reports the block,
 *    so its own per-key report is the surface for this one.
 *  - a duplicate field row ARRIVING after the change, carrying a value row the
 *    other device wrote under the old codec. The rows this pass converted and
 *    the one that arrives now spell the same value differently, so the union
 *    that folds duplicates no longer folds them and the cell gains a member.
 *    Not reachable by the reconcile above, which compares a cell against its
 *    field rows and finds them in agreement. Arrival order is not the
 *    initiator's to control, so this is accepted rather than guarded: the
 *    alternative is keeping the arriving row's spelling, which is the #1055
 *    bug this pass exists to fix.
 *
 * The FAN-OUT is dormant until a definition has field rows — see
 * `consumingParentIds`, which is its gate. The refusals split on that gate and
 * the split is deliberate: `MIGRATION_RUNNING_REFUSAL` exists precisely because
 * a consumer with no field row YET is invisible to it, while the unconvertible
 * refusal is a fact about values this pass actually read and so can only be
 * reached through it.
 */

import {
  defineSameTxProcessor,
  ProcessorRejection,
  type AnyPropertySchema,
  type BlockData,
  type SameTxCtx,
} from '@/data/api'
import { parsePropertyDefinitionMetadata } from '@/data/propertyDefinitionMetadata'
import { isResolvableFieldDefinition } from './propertySchemaResolution'
import { presetConfigProp, presetIdProp } from '@/data/properties'
import { peekRowProperty } from '@/data/rowProperty'
import { jsonValuesEqual } from './jsonCanonical'
import {
  deriveReferenceColumns,
  sameTxReferenceTargetLookups,
} from './referenceTargetProcessor'
import { tryBuildSchema } from '@/data/userSchemasService'
import {
  FANOUT_REPORT_STRIDE,
  reportPropertyDefinitionFanout,
} from '@/data/propertyDefinitionFanout'
import {
  STRANDED_CLAIM_RECOVERY,
  isGraphBackfillClaimActive,
} from './graphBackfillClaim'
import { PROPERTY_CELL_BACKFILL_ID } from './propertyCellBackfill'
import {
  childContentsToEncodedPropertyValue,
  convertValueChildContent,
  fieldRowValues,
  projectedValueCount,
  propertiesEqual,
  unionValuesAcrossFieldRows,
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
 *  exactly. Every observable derived from the codec only approximates it, and
 *  each approximation has a blind spot: `codec.type` cannot tell
 *  `optional-string` from `string`, a preset id alone cannot see a configurable
 *  preset whose `build(config)` returns a different codec, and the two together
 *  still miss a config edit that moves between codecs SHARING a type.
 *
 *  Deliberately wider than it needs to be: a config edit that did not move the
 *  encoding re-parses the value children, which writes nothing
 *  (`value.content !== canonical` guards it) and refuses nothing (a codec that
 *  reads leniently across the edit converts every value it already held). */
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

/**
 * Changes whose destination, or whose vacated name, is not this definition's to
 * write. The caller REFUSES the transaction over any of them that has consumers
 * (#1028): a rename whose consumers cannot be re-keyed is the mass silent unset
 * this pass exists to prevent, so committing the row without its fan-out is
 * committing half a change.
 *
 * `claimOf` answers who holds a name once THIS TX COMMITS, derived from the
 * ROWS rather than accumulated source by source: definitions the tx deletes,
 * revives, creates, renames or strips of their metadata all move a name, and
 * none of them appears in the tx-start registry under the name it ends up with.
 * It describes the state the tx WOULD commit, which is the state the refusal is
 * judged against.
 *
 *  - The DESTINATION is contested when anyone ELSE holds it after commit, or
 *    when anyone else ARRIVES at it. Two definitions landing on one key means
 *    the later write wins a race the rebuilt registry may decide the other way.
 *  - The name being VACATED is contested when anyone else will hold it whose
 *    cells this pass does not fix. Whoever inherits the key this rename drops
 *    is stranded by it — unless they are a peer in this same batch, which
 *    re-keys its own consumers under that name in this same tx.
 *
 * `null` is not "nobody claims it" — it is a workspace with no registry, where
 * nothing can be judged, so it is contested too.
 *
 * WHAT THIS STILL DOES NOT REACH: a name's cells outlive the definition that
 * owned it, and the ways of leaving a name that do NOT pass through here — a
 * deletion, losing the definition metadata — still commit, leaving that
 * definition's consumers keyed under a name whoever takes it next reads through
 * their own schema. That is the same question one step out, and the answers are
 * a reconcile or retiring the departing cells (#1031).
 */
export interface NameClaim {
  /** Definitions that will STILL hold this name once the tx commits, winner
   *  first — the tx-start claimants minus any the tx moves off it. The head is
   *  the one that projects, so an owner that leaves hands that role on. */
  readonly holding: readonly string[]
  /** Definitions that will NEWLY hold it: created, revived, or renamed onto
   *  it. */
  readonly arriving: readonly string[]
}

export const contestedChanges = <T extends {
  readonly fieldId: string
  readonly oldName: string
  readonly newName: string
}>(
  candidates: readonly T[],
  claimOf: (name: string) => NameClaim | null,
): T[] => {
  const batch = new Set(candidates.map(candidate => candidate.fieldId))
  return candidates.filter(candidate => {
    const destination = claimOf(candidate.newName)
    if (destination === null) return true
    const owner = destination.holding[0]
    if (owner !== undefined && owner !== candidate.fieldId) return true
    if (destination.arriving.some(peer => peer !== candidate.fieldId)) return true
    // A change that KEEPS its name vacates nothing, so the second half — who
    // inherits what this one drops — does not arise for it.
    if (candidate.oldName === candidate.newName) return false
    const vacated = claimOf(candidate.oldName)
    if (vacated === null) return true
    // A peer in this batch re-keys its own consumers under the name it
    // inherits, in this same tx. EVERY candidate qualifies, not only the
    // uncontested ones: one contested candidate refuses the whole transaction,
    // so there is no outcome in which some fan-outs run and others do not.
    return ![...vacated.holding, ...vacated.arriving]
      .every(peer => peer === candidate.fieldId || batch.has(peer))
  })
}

/** Why a change's fan-out could not run. Both end in the same refusal, and
 *  differ only in what the user is told to do about it. */
type RefusalReason = 'unbuildable' | 'contested'

/** ONE refusal per transaction, whichever cause is found first — the user
 *  fixes one at a time either way, and a combined message would describe a
 *  state that no longer exists after the first fix. The unconvertible-values
 *  refusal in `apply` follows the same rule; its message is not here only
 *  because it is parameterized by a count. */
const REFUSALS: Record<RefusalReason, {code: string; message: string}> = {
  unbuildable: {
    code: 'property.definition-change.unbuildable',
    message:
      'cannot change a property definition whose value type does not load: the '
      + 'blocks using it could not be updated to match. Fix the property type '
      + 'first, then rename or re-type it.',
  },
  contested: {
    code: 'property.definition-change.contested',
    message:
      'cannot rename or re-type a property definition while another definition '
      + 'claims one of the names involved: which of them the property answers '
      + 'to afterwards is not this edit\'s to decide, so the blocks using it '
      + 'could not be updated. Resolve the duplicate name first, or make the '
      + 'changes in separate edits.',
  },
}

/** Refusing every definition rename and re-type for as long as the
 *  cell-to-children backfill holds this workspace's claim (#1029).
 *
 *  The recovery half is {@link STRANDED_CLAIM_RECOVERY}, shared with the pass's
 *  own report of a claim held elsewhere, so an operator who meets both does not
 *  read them as two situations with two things to do.
 *
 *  An in-flight claim is a PROXY for "this workspace still has cell-only
 *  consumers". The exact question needs an unindexed `json_each` scan over
 *  every bag, inside the user's own editing transaction — declined in #1029.
 *  So it does not reach a write that skips the same-tx processors, which
 *  replay does by design; a claim released or completed while consumers
 *  remain; a definition created mid-run (#1052, #1050); or a DELETION, which
 *  leaves no changed name or codec to collect (#1042).
 *
 *  DECLINED: disabling the schema editor under the same predicate. Every
 *  write to a definition already goes through `repo.tx`, so it added a
 *  surface without adding a refusal. */
const MIGRATION_RUNNING_REFUSAL = {
  code: 'property.definition-change.migration-running',
  message:
    'The properties migration is running on this workspace, so a property '
    + 'definition cannot be renamed or given a different type yet: blocks it has '
    + 'not reached still hold this property under its current name, and it would '
    + `never convert them. Wait for it to finish — ${STRANDED_CLAIM_RECOVERY}.`,
} as const

type CollectedChanges =
  | 'unjudgeable'
  | {
      readonly changes: DefinitionChange[]
      /** Changes whose ROW commits but whose fan-out cannot run, with the
       *  reason that decides what the user is told. Held rather than dropped:
       *  each leaves consumers holding values in an encoding the registry will
       *  not be reading them with, so the caller refuses the transaction once
       *  any of them has a consumer. */
      readonly unfanoutable: ReadonlyArray<{fieldId: string; reason: RefusalReason}>
    }

interface DefinitionChange {
  readonly fieldId: string
  readonly oldName: string
  readonly newName: string
  /** The codec every value child is read under and the cell is projected with:
   *  the AFTER row's, which is the one the rebuilt registry will publish. A
   *  change whose after-row builds no codec never becomes a candidate — the
   *  caller refuses it instead. */
  readonly schema: AnyPropertySchema
  /** The codec the definition was PUBLISHING, which is what says what a stored
   *  value child HOLDS — the schema `convertValueChildContent` re-spells FROM,
   *  and what tells a value this edit takes away from one that was already
   *  unreadable. `null` when the before row's preset does not build, where
   *  nothing records the stored encoding. */
  readonly beforeSchema: AnyPropertySchema | null
  /** The stored ENCODING may now differ, so value-child content is rewritten.
   *  False for a pure rename, where the encoding is untouched and the stored
   *  text is already what this codec writes. */
  readonly encodingChanged: boolean
}

/** Definition blocks in `changedRows` whose NAME or CODEC INPUTS changed this
 *  tx. A brand-new definition (no `before`) has no existing consumer cells and
 *  is skipped; one whose after-row builds no codec cannot be reprojected at all
 *  and is held for the caller's refusal, as is a change whose name another
 *  definition claims. */
const collectChanges = (
  ctx: SameTxCtx,
  workspaceId: string,
  changedRows: ReadonlyArray<{before: BlockData | null; after: BlockData | null}>,
): CollectedChanges => {
  // Pass 1: candidate changes (name or codec inputs differ, after row builds).
  const candidates: DefinitionChange[] = []
  const unfanoutable: Array<{fieldId: string; reason: RefusalReason}> = []
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
    // A row that was not a definition BEFORE re-enters with no before-state to
    // diff, so a bag edited while it was unpublished is invisible here — the
    // metadata arm of #1031, same accepted case as the tombstone one below.
    if (!afterMeta || !beforeMeta) continue
    // A SEED's name and preset are code-owned and frozen once shipped
    // (`seedIdentityLedger.ts`), so a change to either across a build is a
    // deliberate migration (#797) rather than a user edit for this pass to fan
    // out. The materializer writes those rows under Automation scope, which
    // would otherwise reach this processor. Unpinned: reaching it needs a
    // shipped seed to change a frozen field, which the ledger test refuses
    // first.
    if (afterMeta.seedKey !== undefined) continue
    // There is deliberately no eligibility check for SHADOWING here. The
    // contested-name refusal below already covers both of its shapes from the
    // other side — a shadowed definition renaming away is refused because a
    // peer claims the name it vacates, and one re-typing in place is refused
    // because it is not the head claimant of the name it keeps — and asking the
    // resolver "does this fieldId resolve" instead would conflate shadowing
    // with having no buildable codec, which is the repair case below and must
    // NOT be skipped.
    // Off the block's own rows, never the registry, whose tx-start snapshot is
    // at-or-older than `before` — a change an earlier tx already fanned out
    // would read as this one's and be re-encoded against the wrong before-state.
    //
    // Nothing asks whether the BEFORE row built a codec to DETECT a change,
    // because detection is a function of the two properties compared here: a
    // definition whose broken preset has just been fixed already reports its
    // inputs as changed. The old codec is carried for the CONVERSION, as the
    // only record of what encoding the stored text is in, and `null` there
    // costs the value route rather than the change — the text route still
    // answers.
    //
    // ACCEPTED: a bag edited while the row was UNPUBLISHED (a tombstone, or a
    // row stripped of its metadata) is judged against the MOVED bag, and
    // nothing remembers the encoding its consumers are in. Re-encoding on every
    // revival instead is worse — re-parsing is not the identity for editable
    // representations, so it rewrites every plain restore. #1031.
    const renamed = beforeMeta.name !== afterMeta.name
    const encodingChanged = codecInputsChanged(before, after)
    // Every write to a definition block's bag reaches this processor —
    // MATERIALIZE's own field-row bookkeeping included. Without this, each one
    // would sweep every consumer of that definition inside the user's tx.
    if (!renamed && !encodingChanged) continue
    const afterSchema = buildSchemaOrNull(after, ctx.valuePresets, afterMeta)
    if (afterSchema === null) {
      // This tx leaves the row naming a codec that does not build, so nothing
      // here can reproject a single cell — and the row is the ONLY durable
      // record of what encoding its consumers are in. Whether the OLD preset
      // built is beside the point: the edit overwrites that record either way,
      // and the destination preset can arrive later with no definition-row
      // transaction at all — an extension registering, a code fix — at which
      // point the registry publishes its codec straight over values nothing
      // re-encoded. Held for the caller, which refuses if it has consumers.
      //
      // Repairing a broken definition is unaffected: a preset that BUILDS is
      // not this branch, and with no old codec to read the value with,
      // re-encoding falls to the child's TEXT. What is refused is trading one
      // unavailable preset for another.
      unfanoutable.push({fieldId: after.id, reason: 'unbuildable'})
      probeName ??= afterMeta.name
      continue
    }
    probeName ??= afterMeta.name
    candidates.push({
      fieldId: after.id,
      oldName: beforeMeta.name,
      newName: afterMeta.name,
      schema: afterSchema,
      beforeSchema: buildSchemaOrNull(before, ctx.valuePresets, beforeMeta),
      encodingChanged,
    })
  }
  if (candidates.length === 0 && unfanoutable.length === 0) {
    return {changes: [], unfanoutable}
  }
  // ONE derivation of what this tx does to names, read off the ROWS: every
  // definition it touches either keeps the name the tx-start registry files it
  // under, or LEAVES it — by being deleted, renamed, or stripped of the
  // metadata that made it a definition — and may land on a new one. The
  // registry lists no arrival (a created row has no entry, a revived one lost
  // its entry, a renamed one is still filed under its old name), and a revived
  // or created claimant never becomes a candidate either, so this is the only
  // place either can be seen. Both describe the state this tx WOULD commit,
  // which is the state the refusal has to be judged against.
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
  // Pass 2: hold every change whose destination or vacated name another
  // definition also claims — see `contestedChanges` for the two halves.
  const contested = contestedChanges(candidates, (name) => {
    const atTxStart = ctx.propertyDefinitionsClaimingName(workspaceId, name)
    return atTxStart === null
      ? null
      : {
        holding: atTxStart.filter(fieldId => !released.has(fieldId)),
        arriving: arrivingByName.get(name) ?? [],
      }
  })
  for (const candidate of contested) {
    unfanoutable.push({fieldId: candidate.fieldId, reason: 'contested'})
  }
  // Defence in depth, and unpinnable through the public path: a contested
  // change either has a consumer, and then the caller refuses the whole tx, or
  // it has none and there is nothing for it to fan out to. Kept because the
  // cost of that reasoning going stale is a re-key under a name this definition
  // does not own.
  const refused = new Set(contested.map(candidate => candidate.fieldId))
  return {
    changes: candidates.filter(candidate => !refused.has(candidate.fieldId)),
    unfanoutable,
  }
}

/** One bound variable per changed definition would blow
 *  SQLITE_MAX_VARIABLE_NUMBER on a scripted transaction that edits a whole
 *  registry's worth of them, and this probe runs INSIDE the user's tx — so the
 *  throw would take their entire edit down. */
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
 *  permanently — #1029.
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
    const rows = await db.getAll<{parent_id: string | null}>(
      `SELECT DISTINCT field.parent_id FROM ${consumingParentsFromSql(chunk.length)}`,
      [workspaceId, ...chunk],
    )
    for (const row of rows) if (row.parent_id !== null) set.add(row.parent_id)
  }
  return [...set]
}

/** §9 selection discipline: field-row discovery keys on the BIT plus the
 *  target (an unmarked `((fieldId))` link row is not a consumer), and
 *  `parent_id IS NOT NULL` — a marked workspace-root row is user content, not
 *  a field row (§9 root half) — never re-key it.
 *
 *  The OWNER must be live too, and that is the half a `deleted = 0` on the
 *  field row does not cover: a soft-deleted block can still own live field
 *  rows. Its bag is history and re-keying it is declined — the live set is
 *  bounded by current usage while the tombstoned set is bounded by ALL-TIME
 *  usage, so re-keying it would put an unbounded write in the user's own
 *  transaction, and #1023 fixes the restore case where it belongs, at
 *  restore. Asked HERE rather than skipped during the walk, so that the
 *  COUNT excludes them as well: on a graph with a long delete history that
 *  number is what decides whether the user is asked at all, and it must not
 *  promise blocks the change will pass over.
 *
 *  Spelled once because two callers ask the same question for one gesture:
 *  {@link countConsumingParents} sizes the fan-out for the confirmation, and
 *  {@link consumingParentIds} then walks it. A drifted copy would show the
 *  user a number that is not the work they consented to. */
const consumingParentsFromSql = (targetCount: number): string =>
  `blocks field
    WHERE field.workspace_id = ?
      AND field.reference_target_id IN (${Array.from({length: targetCount}, () => '?').join(', ')})
      AND field.is_field_form = 1
      AND field.deleted = 0 AND field.parent_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM blocks owner
         WHERE owner.id = field.parent_id AND owner.deleted = 0
      )`

/** How many parents a change to ONE definition would re-key.
 *
 *  Single definition rather than the set {@link consumingParentIds} takes: a
 *  count across several needs that function's cross-chunk `Set` to avoid
 *  double-counting a parent consuming two of them, and no caller has that
 *  question — a gesture edits one definition row. */
export const countConsumingParents = async (
  db: Pick<SameTxCtx['db'], 'getOptional'>,
  workspaceId: string,
  fieldId: string,
): Promise<number> => {
  const row = await db.getOptional<{count: number}>(
    `SELECT COUNT(DISTINCT field.parent_id) AS count
       FROM ${consumingParentsFromSql(1)}`,
    [workspaceId, fieldId],
  )
  return row?.count ?? 0
}

/** How many values this change takes away from ONE parent, comparing what the
 *  definition WAS publishing against what it will publish now.
 *
 *  AT CELL GRAIN, which is the grain the question is about. Asking it per value
 *  row instead — "could the old codec read this text where the new one cannot"
 *  — is a proxy for "was it in the cell", and it is wrong in both directions: a
 *  divergent peer row under a scalar was never projected and would refuse for
 *  nothing, while narrowing a LIST to a scalar loses every member past the
 *  first with every row individually converting fine.
 *
 *  THE BEFORE SIDE IS THE CHILDREN, not the stored cell: the cell is derived,
 *  and one that disagrees with its children is stale by definition — the next
 *  projection drops the difference whether or not this edit happens. The one
 *  exception is a definition whose previous preset does not BUILD, where
 *  nothing can read the children at all; {@link heldValueCount} owns what is
 *  countable there and why it is deliberately weak. */
const valuesLostBy = (
  change: DefinitionChange,
  parent: BlockData,
  perFieldRow: readonly (readonly BlockData[])[],
  projected: unknown,
): number => {
  // A SHORT-CIRCUIT, not a guard: deleting it changes no outcome, because a
  // rename re-spells nothing and both sides then project identically. It saves
  // rebuilding the before-projection over every value of every consumer on the
  // commonest edit there is.
  if (!change.encodingChanged) return 0
  const after = projectedValueCount(change.schema, projected)
  return Math.max(0, heldValueCount(change, parent, perFieldRow, after) - after)
}

/** How many values the property held BEFORE this change, at the same grain
 *  {@link projectedValueCount} answers in — or, where nothing can read the
 *  children, the most this can claim it held without inventing a loss. */
const heldValueCount = (
  change: DefinitionChange,
  parent: BlockData,
  perFieldRow: readonly (readonly BlockData[])[],
  after: number,
): number => {
  if (change.beforeSchema !== null) {
    return projectedValueCount(change.beforeSchema, childContentsToEncodedPropertyValue(
      change.beforeSchema,
      unionValuesAcrossFieldRows(change.beforeSchema, perFieldRow)
        .map(value => value.content),
    ))
  }
  // No old codec, so this number has to be a LOWER bound on what was held or
  // its slack becomes a phantom loss, and nothing available here measures one
  // tightly. The cell's LENGTH is an upper bound, because the cell cannot say
  // arity — an array is N members of a list, or ONE value of a scalar holding
  // an array. The ROW COUNT is another, because a peer or a duplicate field
  // row was never in the cell while a row this device has not received is
  // missing from it. Combining two upper bounds does not make a lower one.
  //
  // `null` is likewise unreadable at this grain: the cleared sentinel and a
  // real JSON null are the same bytes, and only the codec that wrote them
  // could say which. Counted as a value, because over-refusing costs a
  // repair while under-counting deletes one.
  //
  // So the claim is the weakest sound one: a loss only where the projection
  // comes out EMPTY over a cell that held anything. It misses a narrowing
  // that keeps one member (#1090) and it refuses a repair over a genuinely
  // cleared value (#1077), and both are the same gap — counting this needs
  // the children rebuilt FROM the cell rather than guessed at.
  const held = parent.properties[change.oldName]
  if (held === undefined) return 0
  return after > 0 ? 0 : 1
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
  lostByField: Map<string, number>,
  lostParents: Set<string>,
): Promise<void> => {
  const parent = await ctx.tx.get(parentId)
  // Tombstoned owners are excluded by `consumingParentsFromSql`, which is the
  // one place that decides what a consumer is — so this is only the row
  // vanishing between the probe and here.
  if (parent === null) return
  const referenceLookups = sameTxReferenceTargetLookups(ctx.tx)
  const siblings = await ctx.tx.childrenOf(parentId, undefined)
  // Collected across EVERY change, then applied in two phases below — see the
  // swap note in this function's doc.
  const oldNames: string[] = []
  const assignments: Array<{name: string; value: unknown; unset: boolean}> = []
  for (const change of changes) {
    // `null` = this parent carries no field row for this definition, so its
    // cell keys for it are none of this change's business. It is also the gate
    // `childContentsToEncodedPropertyValue` is called under.
    const perFieldRow = await fieldRowValues(
      ctx.tx, siblings, change.fieldId, isFieldDefinition,
    )
    if (perFieldRow === null) continue
    const canonicalized: Array<Array<Pick<BlockData, 'id' | 'content'>>> = []
    for (const values of perFieldRow) {
      const group: Array<Pick<BlockData, 'id' | 'content'>> = []
      for (const value of values) {
        // A RENAME touches no encoding, so there is nothing to convert: the
        // stored text is already what this codec writes, and re-spelling it
        // would edit text a person chose. Every row goes through unchanged and
        // the aggregate drops whatever it cannot read, exactly as the
        // projection does — which is what makes "a rename can lose nothing"
        // true by construction rather than by argument.
        if (!change.encodingChanged) {
          group.push({id: value.id, content: value.content})
          continue
        }
        // At value-child GRAIN, both ways: under a list codec this row holds
        // ONE member, and reading it against the whole-array grammar would
        // make every member unreadable.
        //
        // A bare `null` is ambiguous — a literal to a codec that rejects
        // null, the unset sentinel to one that accepts it (#1030). The value
        // route settles it with the codec that WROTE the row, wherever the
        // new one has a spelling for what that read; where it has none the
        // text route re-reads `null` and the ambiguity decides the other way
        // (`list` -> `string`).
        const conversion = convertValueChildContent(
          change.beforeSchema, change.schema, value.content,
        )
        // Left exactly as stored and out of the projection — the same thing
        // the projection itself does with text it cannot read. Whether that
        // COSTS anything is not a per-row question and is not asked here;
        // `valuesLostBy` asks it of the aggregate.
        if (conversion.outcome === 'unreadable') continue
        const canonical = conversion.content
        group.push({id: value.id, content: canonical})
        if (value.content === canonical) continue
        // Re-stamp the reference columns from the REWRITTEN content, the same
        // duty every same-tx processor that rewrites `content` after
        // `core.deriveReferenceTarget` already ran carries (merge retarget,
        // deleted-block inlining). This processor's writes are
        // `settledWrites`, so the derive re-run will never revisit the row —
        // the column would keep naming a target the content no longer
        // references. Retyping a ref property to a text one is the case:
        // `((id))` becomes the bare id. Always an update of an existing row,
        // so an unresolvable alias clears the column rather than preserving a
        // prior id.
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
      canonicalized.push(group)
    }
    // Union ACROSS field rows, the same rule the projection runs, over the
    // CANONICAL text because that is what gets published. Both this and
    // `childContentsToEncodedPropertyValue` own what a definition's value is at
    // either grain — a list property is N sibling value children, and a
    // first-parseable-wins read here would publish one member and let
    // MATERIALIZE reap the rest.
    const canonicalContents = unionValuesAcrossFieldRows(change.schema, canonicalized)
      .map(value => value.content)
    const projected = childContentsToEncodedPropertyValue(change.schema, canonicalContents)
    const lost = valuesLostBy(change, parent, perFieldRow, projected)
    if (lost > 0) {
      lostByField.set(change.fieldId, (lostByField.get(change.fieldId) ?? 0) + lost)
      lostParents.add(parentId)
    }
    if (change.oldName !== change.newName) oldNames.push(change.oldName)
    // ALWAYS publish. The cell is projected FROM the children, so publishing
    // what they now read as is the only write that leaves the two agreeing; a
    // skipped publish leaves the cell holding what an EARLIER codec projected,
    // which the next reprojection silently replaces — the deferred emptying
    // #1024 is about. It is also what a rename needs: the old key is dropped
    // just below, so declining to write the new one drops the property
    // outright, every readable member of it included.
    //
    // Nothing is ever published over a value this change takes away, because
    // `valuesLostBy` counted it and the caller refuses the whole transaction
    // before any of this commits.
    assignments.push({
      name: change.newName, value: projected, unset: projected === undefined,
    })
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
    const {changes, unfanoutable} = collected
    // ABOVE the refusal below and above the two dormancy returns under it: every
    // one of those consults `consumingParentIds`, which sees FIELD ROWS, and the
    // hazard here is a consumer that has none. The runbook flips before
    // backfilling, so a chunked backfill's un-reached parents hold cells for
    // this definition and no field row — which makes a definition with NO field
    // rows the WORST case rather than an exempt one.
    //
    // Permanent rather than late, and NOT because later batches stop resolving
    // the old name — the pass holds ONE resolver for its whole run (see where
    // `resolveNameSchema` is bound in `Repo`), so they go on resolving it. That
    // is what makes it permanent: the parents the fan-out reached are re-keyed,
    // the parents it did not are materialized under the name and codec this tx
    // just moved off, and nothing re-derives either half afterwards. DECLINED,
    // fanning out to those owners instead: finding them is an unindexed
    // `json_each` scan over the workspace's bags inside the user's own editing
    // transaction (#1029).
    //
    // These two lists PARTITION the renames and re-types this tx makes — every
    // candidate ends in exactly one of them — so together they answer "does
    // this transaction change a definition at all", which is the question here.
    // Reading them is sound only while that holds: a change dropped into
    // NEITHER would commit its new name with its consumers unreached and this
    // gate would not even look. #1028 made the contested ones held rather than
    // dropped, which closed the last such path.
    //
    // What the gate keeps out is the writes that are not a rename or a re-type
    // at all — a CREATE has no before row, and neither an unrelated bag edit
    // nor the materializer's own field-row bookkeeping survives
    // `collectChanges`. That is what lets the migration gesture mint its orphan
    // definitions while holding its own claim.
    if (changes.length > 0 || unfanoutable.length > 0) {
      // The TRANSACTION's own view, like every other read here. The claim is
      // synced data, so a peer device holding the row refuses too.
      if (await isGraphBackfillClaimActive(
        ctx.db, event.workspaceId, PROPERTY_CELL_BACKFILL_ID,
      )) {
        throw new ProcessorRejection(
          MIGRATION_RUNNING_REFUSAL.message, MIGRATION_RUNNING_REFUSAL.code,
          {
            workspaceId: event.workspaceId,
            fieldIds: [...changes.map(change => change.fieldId),
                       ...unfanoutable.map(held => held.fieldId)],
          },
        )
      }
    }
    if (unfanoutable.length > 0) {
      // Only a change with CONSUMERS strands anything; one on an unused
      // definition is the user's to make, and telling them to fix something
      // first would be friction for nothing.
      const stranded = await consumingParentIds(
        ctx.db, event.workspaceId, unfanoutable.map(held => held.fieldId),
      )
      if (stranded.length > 0) {
        // Named for the first reason held, per `REFUSALS`.
        const {code, message} = REFUSALS[unfanoutable[0]!.reason]
        throw new ProcessorRejection(
          message, code, {fieldIds: unfanoutable.map(held => held.fieldId)},
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
    const isFieldDefinition: IsPropertyFieldDefinition = (fieldId) =>
      changing.has(fieldId)
      || isResolvableFieldDefinition(
        ctx.resolvePropertySchemaField(event.workspaceId, fieldId),
      )
    const lostByField = new Map<string, number>()
    const lostParents = new Set<string>()
    const changingFieldIds = changes.map(change => change.fieldId)
    let done = 0
    for (const parentId of parentIds) {
      await applyToParent(
        ctx, parentId, changes, isFieldDefinition, lostByField, lostParents,
      )
      done += 1
      // Unconditional, and a no-op unless a gesture opened a run for this
      // workspace — the processor does not decide whether anyone is watching.
      //
      // Three moments, and each is a state the surface cannot reach without
      // it. The FIRST turns "Starting…" into a number, which is when the user
      // is likeliest to think nothing is happening. Every STRIDE moves the
      // bar. And the LAST says the consumers are done and the commit is what
      // remains — a total that is not a multiple of the stride would
      // otherwise sit at the previous one for the whole tail, reading
      // "1,000 of 1,124" while the transaction commits, and then vanish.
      // Still not the END of the run: the commit and the post-commit walk
      // come after it, and the gesture that opened the run is what closes it.
      if (done === 1 || done === parentIds.length || done % FANOUT_REPORT_STRIDE === 0) {
        reportPropertyDefinitionFanout(
          event.workspaceId, changingFieldIds, done, parentIds.length,
        )
      }
    }
    // REFUSE rather than commit a change that takes a value away. Every write
    // above rolls back with the definition row, so the graph is left exactly as
    // it was and the user can fix the values or pick a type that holds them.
    //
    // This is the third face of the one rule the other two refusals state: a
    // change must not leave a consumer holding a value in an encoding the
    // registry will not be reading it with. Reporting it after the fact instead
    // cannot keep that promise — the cell goes on holding what the old codec
    // projected until something reprojects it, and then the value is gone with
    // no record of what it was, which is #1024.
    //
    // One refusal per transaction, per `REFUSALS`. The property is named by the
    // name it STILL ANSWERS TO after the rollback, never the one this tx tried
    // to give it, and the blocks ride on `meta` so a surface can offer them:
    // "fix those values" is not actionable without them.
    for (const change of changes) {
      const count = lostByField.get(change.fieldId) ?? 0
      if (count === 0) continue
      throw new ProcessorRejection(
        // Not "cannot be read": `valuesLostBy` counts what the cell would
        // STOP holding, and two readable values that re-spell to the same
        // text converge into one, which is a loss with nothing unreadable in
        // it.
        `cannot change the type of property "${change.oldName}": the blocks `
        + `using it would lose ${count} stored `
        + `value${count === 1 ? '' : 's'}. Fix or remove those values first, `
        + 'or choose a type that can hold them.',
        'property.definition-change.unconvertible',
        {
          fieldId: change.fieldId,
          name: change.oldName,
          count,
          blockIds: [...lostParents],
        },
      )
    }
  },
})
