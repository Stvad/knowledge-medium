/** Writing the strength blocks.
 *
 *  The workout IS the live logging state, not a snapshot taken at the end:
 *  it materializes from the prescription on the first edit (`in-progress`),
 *  and each set is a child block edited in place as you log, so a reload, a
 *  tab switch, or a second device just re-reads the same synced blocks.
 *  Finish flips it to `done` and prunes the un-accepted sets.
 *
 *  The read side lives in the pure `history.ts` module (re-exported below).
 */

import {ChangeScope, propertyValue, type BlockData, type Tx} from '@/data/api/index.js'
import {createChild, deleteBlock} from '@/data/mutators.js'
import {hasBlockType} from '@/data/properties.js'
import type {Repo} from '@/data/repo.js'
import {
  adoptTypedBlock, createTypedChild, getOrCreateTypedChild, type DerivedIdentity,
} from '@/data/typedRecords.js'
// A logged set composes with the built-in todo: the todo type + its `status`
// prop make done-ness the native checkbox and reuse todo tooling.
import {statusProp as todoStatusProp, TODO_TYPE} from '@/plugins/todo/schema.js'

import type {LayoffRecord, SessionType} from '../engine/types'
import {FIELD} from './fields'
import {
  ALT_CHOICE_TYPE,
  EXERCISE_ENTRY_TYPE,
  LAYOFF_TYPE,
  SET_TYPE,
  WORKOUT_TYPE,
  choiceGroupProp,
  choiceOptionProp,
  completedAtProp,
  dateProp,
  definitionProp,
  exerciseProp,
  layoffDaysProp,
  layoffFromProp,
  layoffPctProp,
  layoffTierProp,
  layoffToProp,
  prescribedSetsProp,
  prescribedWeightProp,
  repsProp,
  rpeProp,
  sessionProp,
  occurrenceProp,
  setIndexProp,
  sideProp,
  statusProp,
  unitProp,
  weightProp,
  workingWeightProp,
} from './schema'
import {dateToDay, dayToDate} from './day'

export {buildHistory, buildLayoffs, type RowLike} from './history'
import {buildAltChoices, escapeKeyPart, matchLiveExercises, preferredLive, toLiveSet} from './history'
import {finishPlan, type FinishEntry} from './finish'
export type {FinishPlan} from './finish'

// ──── draft shapes the writer consumes ────

export interface SetDraft {
  weight: number
  reps: number
  rpe?: number
  side?: 'L' | 'R'
  done: boolean
  completedAt?: number
}

export interface ExerciseDraft {
  exercise: string
  /** Plan block this exercise was prescribed from, written as a ref so the
   *  definition's backlinks are the lift's logged history. */
  definitionId?: string
  /** Which row of this lift the session is on. Carried in, not recounted
   *  here — counting from a different array is how a row could end up
   *  writing into its neighbour's blocks. See `liftKey`. */
  occurrence: number
  unit: string
  prescribedWeight?: number
  prescribedSets?: number
  sets: readonly SetDraft[]
}

export interface WorkoutDraft {
  day: string
  session: SessionType
  exercises: readonly ExerciseDraft[]
}

/** The block ids of a materialized workout, so the UI can address individual
 *  set blocks for in-place edits without re-deriving them from a query. */
export interface ExerciseEntryIds {
  id: string
  setIds: string[]
}

export interface MaterializedWorkout {
  workoutId: string
  exercises: ExerciseEntryIds[]
}

const sessionLabel = (session: SessionType): string =>
  session === 'mini' ? 'Mini day' : `Session ${session}`

/** Which training day a raw `date` property lands on, read the way
 *  `buildLiveWorkouts` reads it: `undefined` for anything that doesn't
 *  decode as a day, same as an unreadable date makes a row invisible there. */
const liveDay = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? undefined : dateToDay(date)
}

// No ✓ prefix — the composed todo checkbox conveys done-ness.
const setContent = (set: SetDraft, unit: string): string => {
  const side = set.side ? `${set.side} ` : ''
  return `${side}${set.weight}${unit} × ${set.reps}`
}

const todoStatus = (done: boolean): 'open' | 'done' => (done ? 'done' : 'open')

type TypeSnapshot = ReturnType<Repo['snapshotTypeRegistries']>

// ──── derived identities ────
//
// Every block of a logged session has its id DERIVED from what it is, not
// minted at random — the create fires from a checkbox tap at a moment this
// view can't predict, and on first paint the live query still answers `[]`,
// indistinguishable from "nothing logged". Deriving the id makes a duplicate
// workout unrepresentable rather than unlikely: two taps, two tabs, two
// devices converge on one row at sync instead of racing.
//
// Fresh, randomly-generated uuid-v5 namespaces — one per record kind, so two
// kinds can never derive the same id from the same key.
const WORKOUT_NS = '80ae2b6d-7bde-4de7-9790-04e2d24eeb02'
const EXERCISE_NS = '6d216957-1c1f-45c8-8ee6-b44bb0e7f4aa'
const SET_NS = 'feda0816-3421-4fe5-8249-ac2655cc962b'
const LAYOFF_NS = 'cfa6899f-981a-4dac-8eae-978150c019a9'

/** A layoff is keyed on where the gap STARTS, not the whole range: `to`
 *  ("when you came back") is the field two clients can disagree about, and
 *  keying on the range would give the two finishes separate records —
 *  `resolveReentry` would then read the later `to` as most recent and
 *  restart `sessionsBack`, undoing loads already climbed back to. Keyed on
 *  `from`, the second finish ADOPTS the first record instead. */
const layoffIdentity = (workspaceId: string, from: string): DerivedIdentity =>
  ({namespace: LAYOFF_NS, key: `${workspaceId}|${from}`})

const isGapRecord = (block: BlockData, from: string): boolean =>
  liveDay(block.properties[FIELD.layoffFrom]) === from

/** One workout per workspace/day/session — the FIRST one. A second session of
 *  the same type on the same day has nothing left to key on (see
 *  `startWorkout`), so it is minted rather than derived. */
const workoutIdentity = (workspaceId: string, day: string, session: SessionType): DerivedIdentity =>
  ({namespace: WORKOUT_NS, key: `${workspaceId}|${day}|${session}`})

/** Is this block the session the LOGGING VIEW would show for this draft —
 *  same status/date/session fields `buildLiveWorkouts` filters and files on,
 *  so writing here can never target a workout the view fails to render.
 *  Deliberately no type check: the same three properties are both key and
 *  evidence, which lets a workout that lost its type tag be repaired rather
 *  than duplicated. Used for both the derived-id lookup and the page scan. */
const isTonightsLog = (block: BlockData, draft: WorkoutDraft): boolean =>
  block.properties[FIELD.status] === 'in-progress'
  && block.properties[FIELD.session] === draft.session
  && liveDay(block.properties[FIELD.date]) === draft.day

/** The entry a row SAYS it is attached to, if that is still true — live, and
 *  still a child of this workout — `null` otherwise. One definition shared
 *  by both callers, because a stale attachment (the live query can be
 *  behind) fails differently for each: `writeExercise` would write sets
 *  `finishWorkout` never scans; `materializeExercise` would mint a
 *  duplicate lift on every retry. */
const stillAttached = async (
  tx: Tx,
  entryId: string,
  workoutId: string,
): Promise<BlockData | null> => {
  const block = await tx.get(entryId)
  return block && !block.deleted && block.parentId === workoutId ? block : null
}

/** One entry per lift, keyed on the plan block where there is one so a lift
 *  renamed mid-session stays the same entry. `occurrence` separates two rows
 *  of the same lift; without it the second row would adopt the first row's
 *  blocks. Same `(plan block ?? name, occurrence)` pair the read side matches
 *  on — see `liftKey` in history.ts; only the string layout differs, since
 *  it's an id we're already committed to. */
const exerciseIdentity = (workoutId: string, key: string, occurrence: number): DerivedIdentity => {
  // `escapeKeyPart`: without it, an exercise NAMED "Bench|1" would derive the
  // same block id as "Bench" at occurrence 1, sharing an entry with a
  // genuinely different lift.
  const part = escapeKeyPart(key)
  return {namespace: EXERCISE_NS, key: occurrence === 0 ? `${workoutId}|${part}` : `${workoutId}|${part}|${occurrence}`}
}

/** Does the block at a row's derived entry id still claim to be that lift —
 *  one clause from `matchLiveExercises`: a row WITH a plan block never
 *  attaches to an entry naming a DIFFERENT one. Deliberately silent about
 *  the NAME, so an entry with no definition (or a row whose plan read
 *  failed) still matches — needed for a session logged while the outline
 *  was unreadable, met later by a client that can read it. */
const stillNamesThisLift = (block: BlockData, ex: ExerciseDraft): boolean => {
  const definition = block.properties[FIELD.definition]
  return typeof definition !== 'string'
    || ex.definitionId === undefined
    || definition === ex.definitionId
}

/** Sets are positional within their entry — including the L/R rows of a
 *  per-side lift, which alternate. */
const setIdentity = (exerciseId: string, index: number): DerivedIdentity =>
  ({namespace: SET_NS, key: `${exerciseId}|${index}`})

/** Everything a set block holds — shared by the derived write and the minted
 *  one, so the two cannot describe different records. */
const setSpec = (exerciseId: string, s: SetDraft, index: number, unit: string, typeSnapshot: TypeSnapshot) => ({
  parentId: exerciseId,
  content: setContent(s, unit),
  types: [SET_TYPE, TODO_TYPE],
  properties: [
    propertyValue(weightProp, s.weight),
    propertyValue(repsProp, s.reps),
    // The same number the block id is derived from, written down so a reader
    // can tell WHICH set this is without counting siblings — and so
    // `placeStraySets` can re-find one when the derived id is gone.
    propertyValue(setIndexProp, index),
    ...(s.rpe !== undefined ? [propertyValue(rpeProp, s.rpe)] : []),
    ...(s.side !== undefined ? [propertyValue(sideProp, s.side)] : []),
    ...(s.completedAt !== undefined ? [propertyValue(completedAtProp, s.completedAt)] : []),
    propertyValue(todoStatusProp, todoStatus(s.done)),
  ],
  typeSnapshot,
})

/** One set block under an exercise entry, inside the caller's transaction.
 *  Adopts the block already at this position rather than appending a second
 *  one, so re-running the write for a half-logged session gets its existing
 *  ids back.
 *
 *  `null` when the derived id is taken — by a tombstoned set, or one that has
 *  since left the entry. `placeStraySets` fills those positions in. */
const writeSetBlock = async (
  repo: Repo,
  tx: Tx,
  exerciseId: string,
  s: SetDraft,
  index: number,
  unit: string,
  typeSnapshot: TypeSnapshot,
): Promise<string | null> => {
  const outcome = await getOrCreateTypedChild(repo, tx, {
    identity: setIdentity(exerciseId, index),
    // Positional: see `writeExercise`. A set dragged out of its lift is no
    // longer this row's set, and writing into it would leave an open todo
    // that Finish can never reach.
    adoptable: block => block.parentId === exerciseId,
    ...setSpec(exerciseId, s, index, unit, typeSnapshot),
  })
  if (outcome.status === 'taken') return null

  // Repair the stored index on adopt: the READ path trusts this hand-editable
  // property to place the set, so a stale one would show it in the wrong row.
  if (outcome.status === 'adopted' && outcome.block.properties[FIELD.setIndex] !== index) {
    await tx.setProperty(outcome.id, setIndexProp, index)
  }
  return outcome.id
}

/** Fill in the set rows whose derived id was taken, in place. Those rows need
 *  a block that is NOT the one their identity names, and there's no second
 *  identity to derive — so mint one, and find it by what it says it is on
 *  the NEXT run rather than by where it hashes to (this write re-runs on
 *  every resync; minting blind would append another set block each time).
 *  Only consulted for rows the derivation could not answer. */
const placeStraySets = async (
  repo: Repo,
  tx: Tx,
  exerciseId: string,
  ex: ExerciseDraft,
  typeSnapshot: TypeSnapshot,
  setIds: (string | null)[],
): Promise<void> => {
  const claimed = new Set(setIds.filter((id): id is string => id !== null))
  const strays = new Map<number, BlockData>()
  for (const child of await tx.childrenOf(exerciseId, undefined, {hidePropertyChildren: true})) {
    if (claimed.has(child.id)) continue
    const at = child.properties[FIELD.setIndex]
    if (typeof at !== 'number') continue
    // The index is what we're looking this block up BY, so it can't also be
    // the evidence that the block is a set — `provenSet` is the credential;
    // hand-annotating a note with `strength:setIndex` doesn't make it one.
    const isSet = provenSet(child)
    // First one wins: `childrenOf` orders by `(order_key, id)`, the same
    // order every replica sees.
    if (isSet && !strays.has(at)) strays.set(at, child)
  }

  for (const [index, id] of setIds.entries()) {
    if (id !== null) continue
    const spec = setSpec(exerciseId, ex.sets[index], index, ex.unit, typeSnapshot)
    const stray = strays.get(index)
    // Adopting, not rewriting: a stray holds a real logged set, and the whole
    // reason to look for it is that it is not disposable.
    setIds[index] = stray
      ? (await adoptTypedBlock(repo, tx, stray, spec.types, typeSnapshot)).id
      : await createTypedChild(repo, tx, spec)
  }
}

/** One exercise entry + its set blocks, inside the caller's transaction.
 *  Shared by "start the session" and "add this lift mid-session", so an entry
 *  written either way is identical — and, because the ids are derived,
 *  switching an `or`-group away and back RESTORES the sets you logged on it
 *  instead of starting a parallel entry beside them. */
const writeExercise = async (
  repo: Repo,
  tx: Tx,
  workoutId: string,
  ex: ExerciseDraft,
  typeSnapshot: TypeSnapshot,
  /** The entry this row is already attached to, when the caller has one — an
   *  entry's id normally derives from the lift, but a row can be attached to
   *  one whose id does NOT re-derive (logged while the plan outline was
   *  unreadable, so keyed on the lift's name instead). What the row is
   *  attached to wins; only an unattached row derives. */
  entryId?: string,
): Promise<ExerciseEntryIds> => {
  // An attached entry is only the authority while it's still IN this
  // workout — the shortcut below skips the parent check the derived path
  // gets from `adoptable`, so a dragged-out entry would get sets that
  // `finishWorkout` never scans. Fall back to deriving instead.
  if (entryId !== undefined) {
    const attached = await stillAttached(tx, entryId, workoutId)
    if (!attached) entryId = undefined
    // Re-tag it, the way `getOrCreateTypedChild` re-tags what it adopts —
    // this shortcut skips that, and an untyped entry drops out of the typed
    // query and makes Finish refuse the whole session.
    else if (!hasBlockType(attached, EXERCISE_ENTRY_TYPE)) {
      await repo.addTypeInTx(tx, entryId, EXERCISE_ENTRY_TYPE, {}, typeSnapshot)
    }
  }

  if (entryId !== undefined && ex.definitionId !== undefined) {
    // Backfill the plan-block ref, only when the entry has none — logged
    // while the outline was unreadable, its backlinks would otherwise
    // silently skip that session forever. Never an overwrite: an entry
    // already naming a definition keeps it.
    const existing = await tx.get(entryId)
    if (existing && !existing.deleted && existing.properties[FIELD.definition] === undefined) {
      await tx.setProperty(entryId, definitionProp, ex.definitionId)
    }
  }

  const entrySpec = {
    parentId: workoutId,
    content: ex.exercise,
    types: [EXERCISE_ENTRY_TYPE],
    properties: [
      propertyValue(exerciseProp, ex.exercise),
      ...(ex.definitionId !== undefined ? [propertyValue(definitionProp, ex.definitionId)] : []),
      propertyValue(unitProp, ex.unit),
      ...(ex.prescribedWeight !== undefined ? [propertyValue(prescribedWeightProp, ex.prescribedWeight)] : []),
      ...(ex.prescribedSets !== undefined ? [propertyValue(prescribedSetsProp, ex.prescribedSets)] : []),
      propertyValue(occurrenceProp, ex.occurrence),
    ],
    typeSnapshot,
  }

  const outcome = entryId !== undefined ? undefined : await getOrCreateTypedChild(repo, tx, {
    identity: exerciseIdentity(workoutId, ex.definitionId ?? ex.exercise, ex.occurrence),
    // Positional: a block dragged out of this workout is not this row's
    // entry any more. …and it has to still SAY it is this lift, since
    // `strength:definition` is an ordinary editable ref — adopting on
    // parentage alone would land the session's sets under an entry
    // attributed to something else.
    adoptable: block => block.parentId === workoutId && stillNamesThisLift(block, ex),
    ...entrySpec,
  })

  // The derived id is taken, so this row needs an entry that isn't the one
  // its identity names. Minting is safe here without a lookup beside it: the
  // caller already matched this row against the workout's existing entries
  // and passed the answer in as `entryId`.
  const created = outcome === undefined
    ? undefined
    : outcome.status === 'taken'
      ? await createTypedChild(repo, tx, entrySpec)
      : undefined
  const exId = created ?? outcome?.id ?? (entryId as string)
  const isNew = outcome?.status === 'created' || created !== undefined

  // Repair the stored occurrence on any block we did NOT just create: the
  // READ path places rows by this number, so a stale copy would show a row's
  // sets under the wrong entry.
  if (!isNew) {
    const before = await tx.get(exId)
    if (before && !before.deleted && before.properties[FIELD.occurrence] !== ex.occurrence) {
      await tx.setProperty(exId, occurrenceProp, ex.occurrence)
    }
  }

  const setIds: (string | null)[] = []
  for (const [i, s] of ex.sets.entries()) {
    setIds.push(await writeSetBlock(repo, tx, exId, s, i, ex.unit, typeSnapshot))
  }
  // Only pays for the extra read when the derivation came up short — never
  // on a brand-new entry, since nothing was under it to be in the way.
  if (setIds.includes(null)) await placeStraySets(repo, tx, exId, ex, typeSnapshot, setIds)
  return {id: exId, setIds: setIds as string[]}
}

// ──── live logging writes ────

/** Begin logging tonight's session: get-or-create the workout, one entry per
 *  prescribed lift, and one block per set — all in a single transaction, so
 *  it lands and undoes atomically. Safe to call again for the same session:
 *  everything is addressed by a derived id, so a second call adopts what the
 *  first made and leaves already-logged values exactly as they are.
 *
 *  The one thing it will NOT adopt is a workout already marked `done` — "I
 *  did session A twice today" has to stay representable, and there's no
 *  second id to derive for it: "which came first" is only knowable from rows
 *  a device happens to hold, so a derived id would mean different things on
 *  different devices (one device's insert would collide with and lose to
 *  the other's, logging the evening into the morning's finished record). So
 *  the repeat session falls back to a LOOKUP inside the transaction, where
 *  the answer can't change between read and write, and mints only if that
 *  comes back empty. */
export const startWorkout = async (
  repo: Repo,
  workspaceId: string,
  pageId: string,
  draft: WorkoutDraft,
): Promise<MaterializedWorkout> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  // Candidate ids for the repeat-session lookup below, from the SAME
  // workspace-wide population the logging view reads — a page-children-only
  // scan would miss a session filed under a year heading. Ids only, read
  // before the transaction (`Tx` has no arbitrary queries) and re-checked
  // inside it, so a stale list can only cause a mint, never a bad adoption.
  const known = (await repo.query.typedBlocks({workspaceId, types: [WORKOUT_TYPE]}).load())
    .map((row: {id: string}) => row.id)
  return repo.tx(async tx => {
    const workoutSpec = {
      parentId: pageId,
      content: `${sessionLabel(draft.session)} · ${draft.day}`,
      position: {kind: 'first'} as const,
      types: [WORKOUT_TYPE],
      properties: [
        propertyValue(sessionProp, draft.session),
        propertyValue(dateProp, dayToDate(draft.day)),
        propertyValue(statusProp, 'in-progress'),
      ],
      typeSnapshot,
    }
    // Is a session already standing? Asked BEFORE deriving: a workout from
    // before derived ids carries a RANDOM id, leaving the derived seat empty
    // however live it is — deriving first there would build a second
    // workout beside it, and `preferredLive` picking between them by id
    // could hide either the pre-upgrade sets or the edit just made.
    //
    // Page's children AND anything the workspace-wide query knew about,
    // deduped and re-read inside the transaction.
    const seen = new Map<string, BlockData>()
    for (const block of await tx.childrenOf(pageId, undefined, {hidePropertyChildren: true})) {
      seen.set(block.id, block)
    }
    for (const id of known) {
      if (seen.has(id)) continue
      const block = await tx.get(id)
      if (block) seen.set(id, block)
    }
    // `preferredLive`, not "the first one": this scan is ordered
    // `(order_key, id)` while the VIEW reads a query ordered `(created_at,
    // id)` — taking either one's first match let the tap write into a
    // different workout than the one the screen attached to.
    const standing = preferredLive([...seen.values()]
      .filter(block => !block.deleted && isTonightsLog(block, draft)))

    /** Nothing standing: take the derived seat, or mint beside it when that
     *  seat is held by something this session can't use — the day's first
     *  session already finished/discarded, and this is the second. */
    const deriveOrMint = async () => {
      const derived = await getOrCreateTypedChild(repo, tx, {
        identity: workoutIdentity(workspaceId, draft.day, draft.session),
        adoptable: block => isTonightsLog(block, draft),
        ...workoutSpec,
      })
      return derived.status !== 'taken'
        ? derived
        : {status: 'created' as const, id: await createTypedChild(repo, tx, workoutSpec)}
    }

    const workout = standing !== undefined
      ? await adoptTypedBlock(repo, tx, standing, workoutSpec.types, typeSnapshot)
      : await deriveOrMint()

    // Existing entries may not be the ones this draft would derive (an
    // outline that was unreadable when they were logged keys them on name,
    // not plan block) — matched the way the READ side matches, so "the same
    // lift" can't mean two things.
    const existing = workout.status === 'adopted' ? await liveEntriesOf(tx, workout.id) : undefined
    const matched = matchLiveExercises(
      draft.exercises.map(ex => ({
        definitionId: ex.definitionId,
        exercise: ex.exercise,
        occurrence: ex.occurrence,
      })),
      existing,
    )

    const exercises: ExerciseEntryIds[] = []
    for (const [i, ex] of draft.exercises.entries()) {
      exercises.push(await writeExercise(repo, tx, workout.id, ex, typeSnapshot, matched[i]?.id))
    }
    return {workoutId: workout.id, exercises}
  }, {scope: ChangeScope.BlockDefault, description: `Start ${sessionLabel(draft.session)}`})
}

/** The workout's existing entries, projected the way the READ side matches
 *  them — same function on both sides. Typed OR carrying the exercise
 *  property: a tag is hand-editable, and an entry that lost one is still
 *  the entry this lift was logged into; matching it lets `entryId` re-tag
 *  it rather than deriving a second, plan-keyed entry beside it. */
const liveEntriesOf = async (
  tx: Tx,
  workoutId: string,
): Promise<{id: string; exercise: string; definitionId?: string; occurrence?: number}[]> =>
  (await tx.childrenOf(workoutId, undefined, {hidePropertyChildren: true}))
    .filter(row => hasBlockType(row, EXERCISE_ENTRY_TYPE)
      || typeof row.properties[FIELD.exercise] === 'string')
    .map(row => ({
      id: row.id,
      exercise: typeof row.properties[FIELD.exercise] === 'string'
        ? row.properties[FIELD.exercise] as string
        : row.content,
      definitionId: typeof row.properties[FIELD.definition] === 'string'
        ? row.properties[FIELD.definition] as string
        : undefined,
      // Which occurrence the BLOCK says it is — needed because the adopt
      // path and the live-query path would otherwise disagree about
      // ordering, and the repair in `writeExercise` would then stamp both
      // blocks with swapped numbers.
      occurrence: typeof row.properties[FIELD.occurrence] === 'number'
        ? row.properties[FIELD.occurrence] as number
        : undefined,
    }))

/** Add ONE exercise (and its pre-filled sets) to a workout that already
 *  exists — the mid-session case, e.g. switching an `or`-group to the other
 *  option. Same shape as `startWorkout` writes, so switching BACK lands the
 *  derived id on the entry already logged into and hands its sets back. */
export const materializeExercise = async (
  repo: Repo,
  workoutId: string,
  ex: ExerciseDraft,
  entryId?: string,
): Promise<ExerciseEntryIds> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
    // The workout has to still be tonight's log: another client can finish it
    // between switching an `or`-group and this create landing, and building
    // an entry under a completed record strands its open todo sets there —
    // omitted, unrendered, and re-adopted by every retry.
    const workout = await tx.get(workoutId)
    if (!workout || workout.deleted || workout.properties[FIELD.status] !== 'in-progress') {
      throw new Error(`materializeExercise: workout ${workoutId} is no longer in progress`)
    }
    // The same in-tx match `startWorkout` does: the caller's `entryId` comes
    // from the LIVE QUERY, which can be behind, and skipping this lookup
    // means every retry mints a new duplicate lift. Lives here (not inside
    // `writeExercise`) because `startWorkout` claims entries for every row
    // AT ONCE, where a per-row lookup could hand one entry to two rows.
    //
    // …and only an attachment that still HOLDS may skip it — `entryId` can
    // name an entry since deleted or dragged out, which `writeExercise`
    // would reject and mint for anyway.
    const attached = entryId !== undefined ? await stillAttached(tx, entryId, workoutId) : null
    const matched = attached?.id ?? matchLiveExercises(
      [{definitionId: ex.definitionId, exercise: ex.exercise, occurrence: ex.occurrence}],
      await liveEntriesOf(tx, workoutId),
    )[0]?.id
    return writeExercise(repo, tx, workoutId, ex, typeSnapshot, matched)
  }, {scope: ChangeScope.BlockDefault, description: `Add ${ex.exercise}`})
}

/** Persist the fields of one set that actually changed, merged over what the
 *  block holds RIGHT NOW (read inside the transaction). A patch, not a
 *  whole-set replace: the draft here can legitimately be behind the block
 *  (the live query answers `[]` until it resolves), so writing the whole
 *  set could replace a real 205×5 with the prescribed 185×8. The merge also
 *  keeps `content` honest, using the weight/reps that will be on the block
 *  after this write. */
export const writeSet = async (
  repo: Repo,
  setId: string,
  patch: Partial<SetDraft>,
  unit: string,
  /** The entry this set is supposed to be under, when the caller knows it. */
  expectedParentId?: string,
  /** …and the workout that entry is supposed to be under — checking only the
   *  set's parent passes when the WHOLE entry moved out of the session, and
   *  the edit would be reported saved yet absent from the finished record. */
  expectedWorkoutId?: string,
): Promise<'written' | 'gone'> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
    const before = await tx.get(setId)
    // NOT a silent no-op: the draft can hold a block id whose block is gone —
    // undone, deleted, or pruned by a Finish this view hasn't caught up
    // with — and swallowing that would leave the checkbox ticked forever.
    // "Gone" also covers gone FROM THE SESSION: a block that lost its
    // `strength-set` tag, or was dragged out from under its lift, is one
    // `finishWorkout` won't scan. Reporting `gone` sends the caller back
    // through the create path, which re-tags and re-homes it.
    if (!before || before.deleted) return 'gone' as const
    if (!hasBlockType(before, SET_TYPE)) return 'gone' as const
    if (expectedParentId !== undefined && before.parentId !== expectedParentId) return 'gone' as const
    if (expectedParentId !== undefined && expectedWorkoutId !== undefined) {
      const entry = await tx.get(expectedParentId)
      if (!entry || entry.deleted || entry.parentId !== expectedWorkoutId) return 'gone' as const
      // …and the workout itself is still tonight's log — another client can
      // finish it while a number is focused here, and the blur that follows
      // would otherwise rewrite a completed record.
      const workout = await tx.get(expectedWorkoutId)
      if (!workout || workout.deleted || workout.properties[FIELD.status] !== 'in-progress') {
        return 'gone' as const
      }
      // Repair the entry's own tag while we're here — a set whose block id is
      // already known never goes through `writeExercise`, so this is the only
      // point on the direct path that can put a lost type back before the
      // typed query drops the entry and Finish refuses the session.
      if (!hasBlockType(entry, EXERCISE_ENTRY_TYPE)) {
        await repo.addTypeInTx(tx, expectedParentId, EXERCISE_ENTRY_TYPE, {}, typeSnapshot)
      }
    }
    // Restore the todo composition if it's been lost: done-ness IS the todo
    // `status`, so a set that kept `strength-set` but lost `todo` still counts
    // internally while dropping out of every native todo query and rendering
    // as no checkbox. Materialization repairs it on create; this is the other
    // way in for a set that already exists.
    if (!hasBlockType(before, TODO_TYPE)) {
      await repo.addTypeInTx(tx, setId, TODO_TYPE, {}, typeSnapshot)
    }
    const {id: _id, ...current} = toLiveSet(before)
    const next: SetDraft = {...current, ...patch}

    const assignments = [
      ...(patch.weight !== undefined ? [propertyValue(weightProp, next.weight)] : []),
      ...(patch.reps !== undefined ? [propertyValue(repsProp, next.reps)] : []),
      ...(patch.rpe !== undefined ? [propertyValue(rpeProp, next.rpe)] : []),
      ...(patch.side !== undefined ? [propertyValue(sideProp, next.side)] : []),
      ...(patch.done !== undefined ? [propertyValue(todoStatusProp, todoStatus(next.done))] : []),
      ...(patch.completedAt !== undefined ? [propertyValue(completedAtProp, next.completedAt)] : []),
    ]
    // `completedAt: undefined` inside the patch means "un-done, clear it" —
    // distinguishable from "not in the patch" only by the key's presence.
    const unset = 'completedAt' in patch && patch.completedAt === undefined ? [completedAtProp] : []

    if (assignments.length > 0 || unset.length > 0) {
      await tx.setProperties(setId, {set: assignments, unset})
    }
    const content = setContent(next, unit)
    if (content !== before.content) await tx.update(setId, {content})
    return 'written' as const
  }, {scope: ChangeScope.BlockDefault, description: 'Log set'})
}

/** A child that IS a set on evidence it cannot have acquired by accident:
 *  the type tag, or — for sets written before that tag existed — BOTH of its
 *  numbers. One number alone is not a signature; a note annotated with a
 *  weight is a note.
 *
 *  `strength:setIndex` is deliberately NOT evidence here: it's the key every
 *  fallback looks a set up BY, so letting it double as credential would let
 *  a hand-edited note pass for a set — and here that's not a mis-render but
 *  a DELETE, since Finish would tag it, read its absent todo status as
 *  un-accepted, and prune it with its whole subtree.
 *
 *  Use this one for anything that WRITES — pruning, adopting, re-tagging. */
const provenSet = (row: {properties: Record<string, unknown>}): boolean =>
  hasBlockType(row, SET_TYPE)
  || (typeof row.properties[FIELD.weight] === 'number'
    && typeof row.properties[FIELD.reps] === 'number')

/** …and this one for anything that REFUSES: "might be a set" is right for a
 *  guard whose answer is "stop and let the user look" (wrong costs a
 *  message), where `provenSet` is right for a guard whose answer is "delete
 *  it" (wrong costs the block). */
const mightBeSet = (row: {properties: Record<string, unknown>}): boolean =>
  provenSet(row) || typeof row.properties[FIELD.setIndex] === 'number'

/** Flip the workout to `done`, stamp each kept exercise's working weight, and
 *  prune the un-accepted sets / empty exercises so the saved record shows
 *  only what was actually performed. One transaction.
 *
 *  Re-reads the whole tree INSIDE the transaction rather than trusting a
 *  plan the caller computed from its draft: done-ness can change from the
 *  outline, a todo view, or another device at any moment, so a
 *  caller-computed plan is minutes old by the time it lands here — and a
 *  narrower re-check would miss an entry's OTHER sets left live, or an entry
 *  a second device added mid-Finish.
 *
 *  The caller's job is to have flushed its own ticks first. */
/** Could anything in this block's subtree be a set? All the way down, not
 *  one level: a note under a note under the lift hides a set just as well.
 *  Depth-bounded because the tree is the user's and nothing stops them
 *  nesting further; at the bound the honest answer is "I did not look",
 *  which has to read as MIGHT rather than doesn't — returning false there
 *  would finish around a live, possibly open todo the record never
 *  mentions. */
const MAX_BURIED_DEPTH = 8
const mightHoldSet = async (tx: Tx, blockId: string, depth = 0): Promise<boolean> => {
  const children = await tx.childrenOf(blockId, undefined, {hidePropertyChildren: true})
  if (depth >= MAX_BURIED_DEPTH) return children.length > 0
  for (const child of children) {
    if (mightBeSet(child)) return true
    if (await mightHoldSet(tx, child.id, depth + 1)) return true
  }
  return false
}

export const finishWorkout = async (
  repo: Repo,
  workoutId: string,
  /** A layoff to record in the SAME transaction, when this session is the
   *  first one back from a break.
   *
   *  Atomic with the finish, not a write beside it: the gap stops being
   *  detectable the moment the finish lands (`detectPendingLayoff` reads no
   *  gap on any later day), so writing it separately and failing loses the
   *  record for good — every session after the first back silently returns
   *  to full loads. */
  layoff?: {pageId: string; record: Omit<LayoffRecord, 'id'>},
): Promise<'finished' | 'gone' | 'nothing-accepted'> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
    // Still ours to finish, checked HERE rather than trusted from the caller:
    // another client can finish this workout between the view's last check
    // and this transaction opening, and re-planning a completed record
    // deletes from it — a historical set someone unchecked goes, and its
    // entry with it if that empties it.
    const workout = await tx.get(workoutId)
    if (!workout || workout.deleted) return 'gone' as const
    if (workout.properties[FIELD.status] !== 'in-progress') return 'gone' as const
    // A workout's children aren't all set blocks: a note under an entry is
    // one, and in a child-backed workspace so is every property row —
    // `hidePropertyChildren` filters those before anything is decided from
    // "has children".
    const children = await tx.childrenOf(workoutId, undefined, {hidePropertyChildren: true})
    const entries = children.filter(row => hasBlockType(row, EXERCISE_ENTRY_TYPE))
    // Children but no entries, or an untyped child that owns set blocks, is
    // not "an empty session" or "a note" — it's a type read that came back
    // wrong. This is the one place in the extension where a misread deletes
    // data (prunes everything, or leaves a lift's open todos stranded outside
    // the record) rather than just showing less, so it refuses instead.
    const untypedWithSets: string[] = []
    for (const child of children) {
      if (hasBlockType(child, EXERCISE_ENTRY_TYPE)) continue
      // The child ITSELF may be a set outdented up here — a set has no
      // children, so checking only descendants would miss it.
      if (mightBeSet(child)) {
        untypedWithSets.push(child.id)
        continue
      }
      // All the way down, like the entry-level check: a typed entry beside
      // it keeps the blanket guard quiet otherwise.
      if (await mightHoldSet(tx, child.id)) untypedWithSets.push(child.id)
    }
    // No entries AT ALL is the same refusal — an empty tree is never consent
    // to commit an empty record. Finish is only reachable with at least one
    // accepted set (`canFinish` in the view), so none here means a peer or a
    // hand-edit removed the last lift in between.
    if (untypedWithSets.length > 0 || entries.length === 0) {
      throw new Error(
        `finishWorkout: workout ${workoutId} has ${children.length} children, `
        + `${entries.length} typed "${EXERCISE_ENTRY_TYPE}"`
        + (untypedWithSets.length > 0 ? `, and ${untypedWithSets.length} untyped one(s) holding sets` : '')
        + ' — refusing to finish, since that would leave logged work out of the record.',
      )
    }
    const exercises: FinishEntry[] = []
    /** Entries holding a child that is NOT a set — a note the user typed under
     *  the lift. */
    const holdsMore = new Set<string>()
    /** Notes that turn out to have a SET indented under them — the same
     *  shape the workout-level refusal already covers one level up, here
     *  under a lift, where `buildHistory` groups sets by their direct
     *  exercise parent. */
    const buriedSets: string[] = []
    /** Set blocks carrying no `strength:completedAt`. Read off the BLOCK, not
     *  `FinishEntry` — a projection that happens to carry the field today
     *  isn't the same as the block saying so. */
    const untimed = new Set<string>()
    for (const entry of entries) {
      const entryChildren = await tx.childrenOf(entry.id, undefined, {hidePropertyChildren: true})
      const sets: typeof entryChildren = []
      let others = 0
      for (const child of entryChildren) {
        // Tagged as a set, or carrying a set's own numbers — a set whose tag
        // went missing is still a set, repaired rather than refused since the
        // tag is the only thing wrong and the user asked to finish.
        if (!provenSet(child)) {
          others += 1
          if (await mightHoldSet(tx, child.id)) buriedSets.push(child.id)
          continue
        }
        // BOTH types — being tagged `strength-set` is no reason to skip the
        // todo repair. Done-ness reads off the raw `status` property, so a
        // set missing only `todo` still counts here and gets KEPT.
        for (const typeId of [SET_TYPE, TODO_TYPE]) {
          if (!hasBlockType(child, typeId)) await repo.addTypeInTx(tx, child.id, typeId, {}, typeSnapshot)
        }
        if (child.properties[FIELD.completedAt] === undefined) untimed.add(child.id)
        sets.push(child)
      }
      if (others > 0) holdsMore.add(entry.id)
      exercises.push({
        id: entry.id,
        exercise: typeof entry.properties[FIELD.exercise] === 'string'
          ? entry.properties[FIELD.exercise] as string
          : entry.content,
        sets: sets.map(toLiveSet),
      })
    }
    if (buriedSets.length > 0) {
      // Refuse rather than repair, as the workout level does: where the
      // user meant a set to sit is a question about their log.
      throw new Error(
        `finishWorkout: workout ${workoutId} has ${buriedSets.length} set(s) buried under a note `
        + '— refusing to finish, since that would leave logged work out of the record.',
      )
    }
    const plan = finishPlan(workoutId, exercises)
    // Entries survived, but nothing accepted did: a peer, or the native todo
    // checkbox in the outline, unchecked or deleted the last one in between.
    // Its OWN outcome, not the two that existed: a throw is unactionable
    // (nothing failed), and `'gone'` says "someone else finished this" when
    // the workout is actually still in progress and now unattended.
    if (plan.keep.length === 0) return 'nothing-accepted' as const

    // Subtree deletes, not `tx.delete`: a note typed under a set block would
    // otherwise stay live under a tombstone. An entry holding anything that
    // ISN'T a set is emptied rather than removed, for the same reason the
    // guard above refuses at the workout level: "no accepted sets" is read
    // off a tag that can go missing.
    for (const exId of plan.removeExerciseIds) {
      if (!holdsMore.has(exId)) {
        await tx.run(deleteBlock, {id: exId})
        continue
      }
      for (const set of exercises.find(entry => entry.id === exId)?.sets ?? []) {
        await tx.run(deleteBlock, {id: set.id})
      }
    }
    // One stamp for the whole session: a set ticked from the OUTLINE goes
    // through the native todo checkbox, which writes only the todo status —
    // so a session logged entirely that way would otherwise carry no
    // `strength:completedAt` for `compareRecords` to place it by among the
    // day's other sessions.
    const finishedAt = Date.now()
    for (const ex of plan.keep) {
      const pruned = new Set(ex.removeSetIds)
      for (const setId of ex.removeSetIds) await tx.run(deleteBlock, {id: setId})
      for (const set of exercises.find(entry => entry.id === ex.exerciseId)?.sets ?? []) {
        if (pruned.has(set.id) || !untimed.has(set.id)) continue
        await tx.setProperty(set.id, completedAtProp, finishedAt)
      }
      await tx.setProperty(ex.exerciseId, workingWeightProp, ex.workingWeight)
    }
    await tx.setProperty(workoutId, statusProp, 'done')
    if (layoff) await writeLayoffInTx(repo, tx, workout.workspaceId, layoff.pageId, layoff.record, typeSnapshot)
    return 'finished' as const
  }, {scope: ChangeScope.BlockDefault, description: 'Finish workout'})
}

/** Throw tonight's session away — the one write here that destroys, and so
 *  the one that has to be surest of what it is looking at. Takes the
 *  WORKOUT id and cascades, rather than a list from the caller's draft,
 *  since the live workout can hold blocks the draft no longer knows about.
 *
 *  `'gone'` means it refused: the workout is not there, or it is no longer
 *  in progress. A peer's finish can land in the gap between render and
 *  click, and deleting unconditionally there would tombstone a COMPLETED
 *  session — the caller says so on screen instead. */
export const discardWorkout = async (
  repo: Repo,
  workoutId: string,
): Promise<'discarded' | 'gone'> =>
  repo.tx(async tx => {
    const workout = await tx.get(workoutId)
    if (!workout || workout.deleted) return 'gone' as const
    if (workout.properties[FIELD.status] !== 'in-progress') return 'gone' as const
    await tx.run(deleteBlock, {id: workoutId})
    return 'discarded' as const
  }, {scope: ChangeScope.BlockDefault, description: 'Discard workout'})

const choiceContent = (label: string): string => `Tracking: ${label}`

/** Record which option of an `or`-group the user is now tracking. One block
 *  per answered group, under the settings block, upserted so switching back
 *  and forth edits the same block instead of growing a log. Both ends are
 *  refs, so "what am I tracking in this slot?" is answerable from the plan
 *  outline's backlinks, and a deleted option leaves a visible dangling link
 *  rather than a silently stale map entry. */
export const writeAltChoice = async (
  repo: Repo,
  settingsBlockId: string,
  groupKey: string,
  optionKey: string,
  label: string,
): Promise<void> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  await repo.tx(async tx => {
    const children = await tx.childrenOf(settingsBlockId)
    const existing = children.find(child =>
      !child.deleted && child.properties[FIELD.choiceGroup] === groupKey)

    if (existing) {
      await tx.update(existing.id, {content: choiceContent(label)})
      await tx.setProperty(existing.id, choiceOptionProp, optionKey)
      return
    }

    await createTypedChild(repo, tx, {
      parentId: settingsBlockId,
      content: choiceContent(label),
      types: [ALT_CHOICE_TYPE],
      properties: [
        propertyValue(choiceGroupProp, groupKey),
        propertyValue(choiceOptionProp, optionKey),
      ],
      typeSnapshot,
    })
  }, {scope: ChangeScope.UserPrefs, description: 'Choose exercise variant'})
}

/** `{groupId: optionId}` for every answered group — the shape the plan
 *  parser resolves `or`-groups against. An unanswered group is simply
 *  absent and falls back to the plan's own default. */
export const readAltChoices = async (
  repo: Repo,
  settingsBlockId: string,
): Promise<Record<string, string>> => {
  const children = await repo.block(settingsBlockId).children.load()
  return buildAltChoices((children ?? []).filter(child => !child.deleted))
}

// ──── layoff + shoulder writes (unchanged) ────

const writeLayoffInTx = async (
  repo: Repo,
  tx: Tx,
  workspaceId: string,
  pageId: string,
  record: Omit<LayoffRecord, 'id'>,
  typeSnapshot: TypeSnapshot,
): Promise<string> => {
  const spec = {
    parentId: pageId,
    content: `Layoff · ${record.days}-day gap → ${Math.round(record.pct * 100)}% (${record.tierId})`,
    position: {kind: 'first'} as const,
    types: [LAYOFF_TYPE],
    properties: [
      propertyValue(layoffFromProp, dayToDate(record.from)),
      propertyValue(layoffToProp, dayToDate(record.to)),
      propertyValue(layoffDaysProp, record.days),
      propertyValue(layoffTierProp, record.tierId),
      propertyValue(layoffPctProp, record.pct),
    ],
    typeSnapshot,
  }
  const outcome = await getOrCreateTypedChild(repo, tx, {
    identity: layoffIdentity(workspaceId, record.from),
    // No parentage check, unlike workout/entry/set records: a layoff is about
    // a gap in time, not where it sits, so a block filed elsewhere is still
    // THIS gap's record. It does have to still SAY it is this gap, though:
    // `layoffAlreadyRecorded` reads `strength:from` rather than the id, and
    // the loss is permanent once the comeback session joins history.
    adoptable: block => isGapRecord(block, record.from),
    ...spec,
  })
  if (outcome.status !== 'taken') return outcome.id

  // The derived seat is held by a tombstone, another workspace's row, or a
  // block whose `from` now names a different gap. There's no second identity
  // to derive, so mint — and look the mint up on the NEXT call rather than
  // add to it, the same way `placeStraySets` re-finds a set by what it says
  // it is. The page's children, because that's where a mint lands.
  const minted = (await tx.childrenOf(pageId, undefined, {hidePropertyChildren: true}))
    .find(block => !block.deleted && block.id !== outcome.id
      && hasBlockType(block, LAYOFF_TYPE) && isGapRecord(block, record.from))
  return minted !== undefined
    ? (await adoptTypedBlock(repo, tx, minted, spec.types, typeSnapshot)).id
    : createTypedChild(repo, tx, spec)
}

export const writeLayoff = async (
  repo: Repo,
  workspaceId: string,
  pageId: string,
  record: Omit<LayoffRecord, 'id'>,
): Promise<string> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(
    tx => writeLayoffInTx(repo, tx, workspaceId, pageId, record, typeSnapshot),
    {scope: ChangeScope.BlockDefault, description: 'Record layoff'},
  )
}

/** Create a todo referencing the shoulder-policy block. `((id))` in the
 *  content plus an explicit reference makes the todo show up in the policy
 *  block's backlinks regardless of when the reference parser runs. */
export const writeShoulderTodo = async (
  repo: Repo,
  workspaceId: string,
  pageId: string,
  triggers: readonly string[],
  policyBlockId: string,
): Promise<string> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  const reason = triggers.join('; ')
  return repo.tx(async tx => {
    const id = await tx.run(createChild, {
      parentId: pageId,
      content: `Book shoulder consult — ${reason} ((${policyBlockId}))`,
      references: [{id: policyBlockId, alias: policyBlockId}],
      position: {kind: 'first'},
    })
    await repo.addTypeInTx(tx, id, 'todo', {}, typeSnapshot)
    return id
  }, {scope: ChangeScope.BlockDefault, description: 'Shoulder trigger → consult todo'})
}
