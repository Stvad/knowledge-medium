/** Writing the strength blocks.
 *
 *  The workout IS the live logging state, not a snapshot taken at the end: it
 *  is *materialized* from the prescription on the first edit (status
 *  `in-progress`), and each set is a child block edited in place as you log —
 *  so a reload, a tab switch, or a second device just re-reads the same synced
 *  blocks. "Finish" flips the workout to `done` (and prunes the un-accepted
 *  sets); until then nothing is lost because the block already holds it.
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
// A logged set composes with the built-in todo: it carries the todo type + its
// `status` prop, so done-ness is the native checkbox and reuses todo tooling.
import {statusProp as todoStatusProp, TODO_TYPE} from '@/plugins/todo/schema.js'

import type {LayoffRecord, SessionType} from '../engine/types'
import {FIELD} from './fields'
import {
  ALT_CHOICE_TYPE,
  EXERCISE_ENTRY_TYPE,
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
import {buildAltChoices, escapeKeyPart, matchLiveExercises, toLiveSet} from './history'
import {LEGACY_SETS_PROP, readLegacySets} from './legacy'
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
  /** Plan block this exercise was prescribed from, when the config came
   *  from the outline — written as a ref so the definition's backlinks are
   *  the lift's logged history. */
  definitionId?: string
  /** Which row of this lift the session is on. Carried in, not recounted
   *  here: the caller's draft is the thing whose rows have to line up with
   *  the entries, and counting again from a different array is how a row
   *  ended up writing into its neighbour's blocks. See `liftKey`. */
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
 *  `buildLiveWorkouts` reads it — the raw bag holds the codec's ISO string,
 *  and an undecodable one means the row is invisible to the logging view.
 *  `undefined` for anything that can't be read as a day at all. */
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
// minted at random. That is what makes starting a session idempotent, and it
// has to be: the create fires from a checkbox tap, at a moment this view
// doesn't choose and can't predict. On first paint the live query still
// answers `[]` — indistinguishable from "nothing logged" — and a tap there
// used to build a second workout that the query then hid behind the first:
// never rendered, never finishable, a full set of open todo sets left in the
// agenda forever.
//
// Deriving the id makes that unrepresentable rather than unlikely. Two taps,
// two tabs, two devices: same inputs, same block ids, so they converge on one
// row at sync instead of racing. No read-before-write, and no window between
// the read and the write for the answer to change.
//
// Fresh, randomly-generated uuid-v5 namespaces — one per record kind, so two
// kinds can never derive the same id from the same key.
const WORKOUT_NS = '80ae2b6d-7bde-4de7-9790-04e2d24eeb02'
const EXERCISE_NS = '6d216957-1c1f-45c8-8ee6-b44bb0e7f4aa'
const SET_NS = 'feda0816-3421-4fe5-8249-ac2655cc962b'

/** One workout per workspace/day/session — the FIRST one. A second session of
 *  the same type on the same day has nothing left to key on (see
 *  `startWorkout`), so it is minted rather than derived. */
const workoutIdentity = (workspaceId: string, day: string, session: SessionType): DerivedIdentity =>
  ({namespace: WORKOUT_NS, key: `${workspaceId}|${day}|${session}`})

/** Is this block the session the LOGGING VIEW would show for this draft?
 *
 *  Every field `buildLiveWorkouts` filters or files on, not just the status:
 *
 *   - `=== 'in-progress'`, not `!== 'done'` — a missing or unreadable status
 *     is not tonight's log either;
 *   - the date has to decode AND land on this day — `buildLiveWorkouts` skips
 *     an undecodable one and files a valid one under whatever day it names;
 *   - the session has to match, for the same reason.
 *
 *  Anything else is a block the view can never render, so writing the session
 *  into it means logging into thin air: the sets land, nothing shows them, and
 *  Finish waits forever for a live workout whose id matches. The date and
 *  session can drift from the id that derived them by an ordinary hand-edit in
 *  the outline.
 *
 *  One predicate for both ways of finding a workout — by derived id, and by
 *  scanning the page — because "the session the view would show" must not be
 *  able to mean two things.
 *
 *  Deliberately no type check, so the same properties are both the key and
 *  the evidence — the circularity `placeStraySets` had to get rid of. Kept
 *  here because it takes THREE namespaced properties coinciding (a status of
 *  exactly `in-progress`, this session letter, a date decoding to this day)
 *  for a non-workout to qualify, where there a single machine-assigned index
 *  was enough; and because tag-tolerance is what lets a workout that lost its
 *  type tag be adopted and repaired rather than duplicated. */
const isTonightsLog = (block: BlockData, draft: WorkoutDraft): boolean =>
  block.properties[FIELD.status] === 'in-progress'
  && block.properties[FIELD.session] === draft.session
  && liveDay(block.properties[FIELD.date]) === draft.day

/** One entry per lift in a workout — keyed on the plan block where there is
 *  one, so a lift renamed mid-session stays the same entry. `occurrence`
 *  separates two rows of the same lift in one session; without it the second
 *  row would adopt the first row's blocks and they would write over each
 *  other. Same `(plan block ?? name, occurrence)` pair the read side matches
 *  on — see `liftKey` in history.ts; only the string layout differs, and it
 *  differs because it is an id we are already committed to.  */
const exerciseIdentity = (workoutId: string, key: string, occurrence: number): DerivedIdentity => {
  // `escapeKeyPart`, because the occurrence-0 spelling omits the occurrence:
  // an exercise NAMED "Bench|1" would otherwise derive the same block id as
  // "Bench" at occurrence 1, and the two rows — which the matcher correctly
  // treats as different lifts — would share an entry and, positionally, a set
  // block per index.
  const part = escapeKeyPart(key)
  return {namespace: EXERCISE_NS, key: occurrence === 0 ? `${workoutId}|${part}` : `${workoutId}|${part}|${occurrence}`}
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
  // Composed with the built-in todo: done-ness is the native checkbox.
  types: [SET_TYPE, TODO_TYPE],
  properties: [
    propertyValue(weightProp, s.weight),
    propertyValue(repsProp, s.reps),
    // The same number the block id is derived from, written down so a reader
    // can tell WHICH set this is without counting its siblings — which stops
    // being the same thing the moment one of them is deleted. It is also what
    // `placeStraySets` re-finds a set by when the derived id is gone.
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
 *  one — which is what lets the caller re-run the whole write for a session
 *  that is half-logged and get its existing ids back.
 *
 *  `null` when the derived id is taken: by the tombstone of a set deleted out
 *  of the middle of the lift, or by a block that has since left the entry.
 *  This index still needs a block and cannot have that one — see
 *  `placeStraySets`, which is where those are filled in. */
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

  // Repair the stored index on adopt, the same way the primitive repairs a
  // missing type tag. It is an ordinary hand-editable property, but the READ
  // path now trusts it to place the set — so an index that disagrees with the
  // one this block's id was derived from would show the set in someone else's
  // row, or nowhere, while every write still resolved here. The derivation is
  // the authority; the property is its readable copy.
  if (outcome.status === 'adopted' && outcome.block.properties[FIELD.setIndex] !== index) {
    await tx.setProperty(outcome.id, setIndexProp, index)
  }
  return outcome.id
}

/** Fill in the set rows whose derived id was taken, in place.
 *
 *  Those rows need a block that is NOT the one their identity names, and
 *  there is no second identity to derive — a fallback id could only ever be
 *  chosen from what this device has synced, which is the one property a
 *  derived id exists for. So: mint one, and make the NEXT run find it again
 *  by what it says it is rather than by where it hashes to. That matters
 *  because this whole write re-runs on every resync; minting blind would
 *  append another set block each time, and each one an open todo Finish
 *  refuses to complete the session around.
 *
 *  Only ever consulted for rows the derivation could not answer. What keeps a
 *  hand-edited `strength:setIndex` from pointing two rows at one block is
 *  `writeSetBlock`'s repair, which stamps every derived-adopted block with the
 *  index its ID says it is before this scan reads any of them; skipping the
 *  already-claimed ids below is a second fence behind that, unreachable while
 *  the repair holds and cheap enough to keep the invariant stated locally. */
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
    // The index is what we are looking this block up BY, so it cannot also be
    // the evidence that the block is a set — `isSetLike` counts it as a
    // signature, which makes it exactly the wrong test here. A note the user
    // hand-annotated with `strength:setIndex` would otherwise be adopted,
    // re-tagged as a set + todo, and rendered as a 0 × 0 row it never was.
    // So the credential has to be something else: the type tag, or the two
    // numbers a set written before that tag existed still carries.
    const isSet = hasBlockType(child, SET_TYPE)
      || (typeof child.properties[FIELD.weight] === 'number'
        && typeof child.properties[FIELD.reps] === 'number')
    // First one wins, so two blocks claiming an index resolve the same way on
    // every device: `childrenOf` orders by `(order_key, id)`, which is the
    // same order every replica sees.
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
  /** The entry this row is already attached to, when the caller has one.
   *
   *  An entry's id normally derives from the lift, but the draft can be
   *  attached to one whose id does NOT re-derive — an entry logged while the
   *  plan outline was unreadable is keyed on the lift's name, and the same
   *  row keys on its plan block once the plan resolves. Deriving there builds
   *  a second entry beside the one on screen and splits the lift in two. What
   *  the row is attached to wins; only an unattached row derives — and only
   *  while it is still a child of this workout. */
  entryId?: string,
): Promise<ExerciseEntryIds> => {
  // An attached entry is only the authority while it is still IN this workout.
  // It can have been dragged out (or deleted) since the snapshot the caller is
  // holding, and the shortcut below skips the parent check the derived path
  // gets from `adoptable` — so the sets would be written under a block
  // `finishWorkout` never scans, and the tap would vanish from the session.
  // Fall back to deriving, which puts them where the workout can see them.
  if (entryId !== undefined) {
    const attached = await tx.get(entryId)
    if (!attached || attached.deleted || attached.parentId !== workoutId) entryId = undefined
    // Re-tag it, the way `getOrCreateTypedChild` re-tags what it adopts. This
    // shortcut skips that, so an entry whose type tag went missing was still
    // accepted on liveness and parentage alone — and then written into. The
    // typed query drops it, Finish refuses the session because an untyped
    // child owns sets, and a later materialization derives a parallel entry
    // beside it. Bypassing the primitive is not a reason to lose its repair.
    else if (!hasBlockType(attached, EXERCISE_ENTRY_TYPE)) {
      await repo.addTypeInTx(tx, entryId, EXERCISE_ENTRY_TYPE, {}, typeSnapshot)
    }
  }

  if (entryId !== undefined && ex.definitionId !== undefined) {
    // Backfill the plan-block ref, and ONLY when the entry has none.
    //
    // This is the case `entryId` exists for: the entry was logged while the
    // outline was unreadable, so it is keyed on the lift's name and carries no
    // `strength:definition`. The ref is what projects a real reference, so
    // without this the definition block's backlinks — "everything I have ever
    // logged for this lift" — silently skip that session forever.
    //
    // New information, never an overwrite: an entry that already names a
    // definition keeps it, because a row is only ever matched to an entry
    // whose definition agrees or is absent.
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
      // A ref, so the definition block's backlinks are this lift's history.
      ...(ex.definitionId !== undefined ? [propertyValue(definitionProp, ex.definitionId)] : []),
      propertyValue(unitProp, ex.unit),
      ...(ex.prescribedWeight !== undefined ? [propertyValue(prescribedWeightProp, ex.prescribedWeight)] : []),
      ...(ex.prescribedSets !== undefined ? [propertyValue(prescribedSetsProp, ex.prescribedSets)] : []),
      // The same number the block id is derived from, written down so a reader
      // can tell WHICH occurrence of the lift this is without counting
      // siblings — which stops being the same thing the moment the user drags
      // them past each other.
      propertyValue(occurrenceProp, ex.occurrence),
    ],
    typeSnapshot,
  }

  const outcome = entryId !== undefined ? undefined : await getOrCreateTypedChild(repo, tx, {
    identity: exerciseIdentity(workoutId, ex.definitionId ?? ex.exercise, ex.occurrence),
    // Positional records: this entry belongs to THIS workout, so a block the
    // user dragged out of it is not this row's entry any more. Adopting one
    // would write the session's sets into another tree, where `finishWorkout`
    // — which reads the workout's children — can never see them again.
    adoptable: block => block.parentId === workoutId,
    ...entrySpec,
  })

  // The derived id is taken by a tombstone or by a block that left the
  // workout, so this row needs an entry that is not the one its identity
  // names. Minting is safe HERE and nowhere else in this file without a
  // lookup beside it: the caller has already matched this row against the
  // workout's existing entries (`matchLiveExercises`) and passed the answer in
  // as `entryId`, so reaching this line means the lookup came back empty.
  const created = outcome === undefined
    ? undefined
    : outcome.status === 'taken'
      ? await createTypedChild(repo, tx, entrySpec)
      : undefined
  const exId = created ?? outcome?.id ?? (entryId as string)
  const isNew = outcome?.status === 'created' || created !== undefined

  // Repair the stored occurrence on any block we did NOT just create — one
  // adopted by the derivation, or handed to us as the attached entry. The READ
  // path places rows by this number, so an entry whose copy disagrees with the
  // row writing into it would show that row's sets under the other one. The
  // row a block is attached to is the authority: rows are claimed once, so the
  // numbers stay unique within a workout.
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
  // Only pays for the extra read when the derivation actually came up short —
  // and on a brand-new entry it cannot, since nothing was under it to be in
  // the way.
  if (setIds.includes(null)) await placeStraySets(repo, tx, exId, ex, typeSnapshot, setIds)
  return {id: exId, setIds: setIds as string[]}
}

// ──── live logging writes ────

/** Begin logging tonight's session: get-or-create the workout, one entry per
 *  prescribed lift, and one block per set — all in a single transaction, so
 *  it lands and undoes atomically. Returns the ids so the caller can write
 *  set edits straight to their blocks.
 *
 *  Safe to call again for the same session. Everything it touches is
 *  addressed by a derived id, so a second call adopts what the first made:
 *  same workout, same entries, same set blocks, and — crucially — the values
 *  already logged in them are left exactly as they are. Only what is genuinely
 *  missing gets written.
 *
 *  The one thing it will NOT adopt is a workout already marked `done`. That
 *  is not tonight's log, it's this morning's — and "I did session A twice
 *  today" (or "I discarded the first attempt and started over") has to stay
 *  representable.
 *
 *  There is no second id to derive for that case. Nothing distinguishes the
 *  evening's session from the morning's except which came first, and "which
 *  came first" is only knowable from rows a device happens to hold — so an id
 *  derived from it stops meaning the same thing on every device, which is the
 *  one property a derived id is for. (Concretely: the device that had synced
 *  the morning session would move to a second id while the device that hadn't
 *  would create at the first, lose that insert to the server's row, and log
 *  the evening into the morning's finished record.)
 *
 *  So the repeat session falls back to what the derivation was standing in for
 *  in the first place: a LOOKUP — here, inside the transaction, where the
 *  answer cannot change between the read and the write — and a minted id only
 *  if the lookup comes back empty. */
export const startWorkout = async (
  repo: Repo,
  workspaceId: string,
  pageId: string,
  draft: WorkoutDraft,
): Promise<MaterializedWorkout> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
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
    const derived = await getOrCreateTypedChild(repo, tx, {
      identity: workoutIdentity(workspaceId, draft.day, draft.session),
      adoptable: block => isTonightsLog(block, draft),
      ...workoutSpec,
    })

    // `taken` — the day's first session of this type is finished, discarded,
    // or hand-edited out of shape, and this is the second. Continue the one
    // already standing if there is one (the same block the logging view would
    // be showing), and only then start a new one.
    const standing = derived.status !== 'taken'
      ? undefined
      : (await tx.childrenOf(pageId, undefined, {hidePropertyChildren: true}))
        // Newest first: `startWorkout` files each session at the top, and
        // `childrenOf` orders by `(order_key, id)` — the same order on every
        // replica, so two devices resolve a tie identically.
        .find(block => block.id !== derived.id && isTonightsLog(block, draft))
    const workout = derived.status !== 'taken'
      ? derived
      : standing !== undefined
        ? await adoptTypedBlock(repo, tx, standing, workoutSpec.types, typeSnapshot)
        : {status: 'created' as const, id: await createTypedChild(repo, tx, workoutSpec)}

    // A workout we did not just create already has entries, and they are not
    // necessarily the ones this draft would derive: a session logged while the
    // plan outline was unreadable is keyed on each lift's NAME, and the same
    // draft keys on plan blocks once the outline resolves (or the reverse, on a
    // client whose read failed). Deriving regardless built a second entry tree
    // beside the first and split the logged sets across the two.
    //
    // So the entries that are here get matched the way the READ side matches
    // them — same function, so "the same lift" cannot mean two things — and
    // whatever a row matches becomes the entry it writes into.
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
 *  them — same function on both sides, so "the same lift" cannot mean two
 *  things.
 *
 *  Typed OR carrying the exercise property. A tag is hand-editable, and an
 *  entry that lost one is still the entry this lift was logged into —
 *  excluded from matching, a plan-keyed draft derives a different id and
 *  splits the session in two. Matching it repairs it: `entryId` re-tags what
 *  it is handed.
 *
 *  That second credential is also part of the match key, which is the shape
 *  `placeStraySets` had to abandon — but here the value has to BE the lift's
 *  name (or its plan block), not merely a number in range, so a block
 *  qualifies only by carrying a namespaced property spelled with the exact
 *  lift the draft is asking about. The repair it buys is one this extension
 *  actually needed. */
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
      // Which occurrence the BLOCK says it is. Without this the adopt path
      // falls back to sibling order while the live-query path reads the stored
      // number — and the two disagreeing is worse than either: the repair in
      // `writeExercise` then stamps both blocks with the swapped numbers, so
      // every later set write lands in the other row's entry.
      occurrence: typeof row.properties[FIELD.occurrence] === 'number'
        ? row.properties[FIELD.occurrence] as number
        : undefined,
    }))

/** Add ONE exercise (and its pre-filled sets) to a workout that already
 *  exists. This is the mid-session case: you switch an `or`-group to the
 *  other option because your shoulder complained, and the option you switched
 *  to has no blocks yet. Same shape as `startWorkout` writes, so the entry is
 *  indistinguishable from one created at the start — and if you switch BACK,
 *  the derived id lands on the entry you already logged into and hands its
 *  sets straight back. */
export const materializeExercise = async (
  repo: Repo,
  workoutId: string,
  ex: ExerciseDraft,
  entryId?: string,
): Promise<ExerciseEntryIds> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
    // The workout has to still be tonight's log. Another client can finish it
    // in the moment between switching an `or`-group and this create landing,
    // and building an entry with a full set of OPEN todo sets under a
    // completed record leaves them stranded there: the record omits them,
    // nothing renders them, and a retry adopts the same unusable tree.
    const workout = await tx.get(workoutId)
    if (!workout || workout.deleted || workout.properties[FIELD.status] !== 'in-progress') {
      throw new Error(`materializeExercise: workout ${workoutId} is no longer in progress`)
    }
    // The same in-tx match `startWorkout` does, and for the same reason: the
    // caller's `entryId` comes from the LIVE QUERY, which can be behind. Left
    // to `writeExercise`, a row whose derived entry id is taken (a tombstone,
    // or a block dragged out of the workout) mints a fresh entry — and this
    // call re-runs, so the next one mints ANOTHER, appending a duplicate lift
    // with a full set of open todo sets every time.
    //
    // Matching one row rather than the whole draft is the difference from
    // `startWorkout`, and it is why the lookup lives here rather than one
    // level down: `startWorkout` claims entries for every row at once, so its
    // claims are exclusive, and a per-row lookup inside `writeExercise` could
    // hand one entry to two of them.
    const matched = entryId ?? matchLiveExercises(
      [{definitionId: ex.definitionId, exercise: ex.exercise, occurrence: ex.occurrence}],
      await liveEntriesOf(tx, workoutId),
    )[0]?.id
    return writeExercise(repo, tx, workoutId, ex, typeSnapshot, matched)
  }, {scope: ChangeScope.BlockDefault, description: `Add ${ex.exercise}`})
}

/** Persist the fields of one set that actually changed, merged over what the
 *  block holds RIGHT NOW (read inside the transaction).
 *
 *  A patch, not a whole-set replace, and that distinction is load-bearing.
 *  The draft this is called from can legitimately be behind the block: the
 *  live query answers `[]` until it resolves, so a tap in that window reaches
 *  a draft that is pure prescription while the block holds a real set you
 *  logged an hour ago. Writing the whole set there replaced 205×5 with the
 *  prescribed 185×8 — and the adopt that had just carefully preserved those
 *  values handed them back one statement later. Writing only the tapped field
 *  makes "the draft's other fields are stale" unrepresentable.
 *
 *  The merge is also what keeps `content` honest: the readable line needs the
 *  weight and reps that will be on the block after this write, not the ones
 *  the caller happens to be holding. */
export const writeSet = async (
  repo: Repo,
  setId: string,
  patch: Partial<SetDraft>,
  unit: string,
  /** The entry this set is supposed to be under, when the caller knows it. */
  expectedParentId?: string,
  /** …and the workout that entry is supposed to be under. Checking only the
   *  set's own parent passes when the WHOLE entry has been moved out of the
   *  session, and `finishWorkout` scans the workout's children — so the edit
   *  would be reported as saved and then be absent from the finished record. */
  expectedWorkoutId?: string,
): Promise<'written' | 'gone'> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
    const before = await tx.get(setId)
    // NOT a silent no-op. The draft can hold a block id whose block is gone —
    // undone (one transaction is one undo step, so a single Cmd-Z after
    // starting a session tombstones its whole subtree), deleted from the
    // outline, or pruned by a Finish this view hasn't caught up with. Swallowing
    // that left the checkbox ticked, the footer saying "Saved as you go", and
    // every later tap doing nothing. The caller surfaces it and re-derives.
    //
    // "Gone" means gone FROM THE SESSION, not merely tombstoned. A block that
    // lost its `strength-set` tag, or that was dragged out from under its
    // lift, is one `finishWorkout` will not scan — so writing into it and
    // reporting success puts a tick on screen for a set the finished record
    // will not contain. Saying `gone` instead sends the caller back through
    // the create path, where the derived id finds this very block, re-tags it
    // and re-homes the write. The repair is the recovery.
    if (!before || before.deleted) return 'gone' as const
    if (!hasBlockType(before, SET_TYPE)) return 'gone' as const
    if (expectedParentId !== undefined && before.parentId !== expectedParentId) return 'gone' as const
    if (expectedParentId !== undefined && expectedWorkoutId !== undefined) {
      const entry = await tx.get(expectedParentId)
      if (!entry || entry.deleted || entry.parentId !== expectedWorkoutId) return 'gone' as const
      // …and the workout itself is still tonight's log. Another client can
      // finish it while a number is focused here, and the blur that follows
      // would rewrite a completed record — the entry and set are still right
      // where they were, so nothing else in this chain notices.
      const workout = await tx.get(expectedWorkoutId)
      if (!workout || workout.deleted || workout.properties[FIELD.status] !== 'in-progress') {
        return 'gone' as const
      }
      // Repair the entry's own tag while we are here. A set whose block id is
      // already known never goes through `writeExercise`, so this is the only
      // point on the direct path that can put back a type the entry lost —
      // and without it the typed query drops the entry and Finish refuses the
      // whole session, because an untyped workout child owns sets.
      if (!hasBlockType(entry, EXERCISE_ENTRY_TYPE)) {
        await repo.addTypeInTx(tx, expectedParentId, EXERCISE_ENTRY_TYPE, {}, typeSnapshot)
      }
    }
    // Restore the todo composition if it has been lost. Done-ness IS the todo
    // `status`, so a set that kept `strength-set` but lost `todo` still counts
    // internally while dropping out of every native todo query and rendering
    // as no checkbox at all — the one thing the composition was for. The
    // materialization path repairs its types; a write to a set that already
    // exists is the other way in.
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

/** A child that IS a set, tag or no tag. Its own numbers are the giveaway,
 *  and the tag is hand-editable — so the guard that refuses a partial read
 *  and the repair that puts the tag back have to agree about what they are
 *  looking at, or a lift whose entry AND sets all lost their tags slips past
 *  the guard and is finished around. */
const isSetLike = (row: {properties: Record<string, unknown>}): boolean =>
  hasBlockType(row, SET_TYPE)
  // Its own index, which nothing but a set carries — or, for sets written
  // before that property existed, BOTH numbers. Either one alone is not a
  // signature: a note annotated with a weight is a note, and promoting it
  // made Finish read its absent status as un-accepted and delete it.
  || typeof row.properties[FIELD.setIndex] === 'number'
  || (typeof row.properties[FIELD.weight] === 'number'
    && typeof row.properties[FIELD.reps] === 'number')

/** Flip the workout to `done`, stamp each kept exercise's working weight, and
 *  prune the un-accepted sets / empty exercises so the saved record shows only
 *  what was actually performed. One transaction.
 *
 *  Takes the workout ID and re-reads the whole tree INSIDE the transaction,
 *  rather than a plan the caller computed from its draft. Every way this has
 *  lost data was a stale-input bug with the same shape: the caller's picture
 *  is minutes old, while done-ness can be set from the outline, a todo view or
 *  another device at any moment — including during Finish's own writes. Here
 *  the answer cannot be out of date, and it costs two indexed child queries
 *  per exercise.
 *
 *  It also covers what the previous re-check could not. That version skipped
 *  deleting an entry someone had logged into, but then left that entry's OTHER
 *  sets live — open todos under a finished workout, unreachable forever. And
 *  an entry a second device added mid-Finish was in neither of the plan's
 *  lists, so it was never considered at all. Both are just "read the tree".
 *
 *  The caller's job is to have flushed its own ticks first. */
/** Does anything in this block's subtree look like a set?
 *
 *  All the way down, not one level: a note under a note under the lift hides a
 *  set just as well, and the record only ever mentions sets that are direct
 *  children of an entry. Depth-bounded because the tree is the user's and
 *  nothing stops them nesting further; the bound is far past any real log, and
 *  refusing to finish is the answer either way. */
const MAX_BURIED_DEPTH = 8
const holdsSetLike = async (tx: Tx, blockId: string, depth = 0): Promise<boolean> => {
  if (depth >= MAX_BURIED_DEPTH) return false
  const children = await tx.childrenOf(blockId, undefined, {hidePropertyChildren: true})
  for (const child of children) {
    if (isSetLike(child)) return true
    if (await holdsSetLike(tx, child.id, depth + 1)) return true
  }
  return false
}

export const finishWorkout = async (
  repo: Repo,
  workoutId: string,
): Promise<'finished' | 'gone'> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
    // Still ours to finish, checked HERE rather than trusted from the caller.
    // Finishing PRUNES, and another client can finish this workout between the
    // view's last generation check and this transaction opening — at which
    // point re-planning a completed record deletes from it: a historical set
    // someone had since unchecked in the outline goes, and its entry with it
    // if that empties it. `discardWorkout` re-reads for the same reason; this
    // one deletes more.
    const workout = await tx.get(workoutId)
    if (!workout || workout.deleted) return 'gone' as const
    if (workout.properties[FIELD.status] !== 'in-progress') return 'gone' as const
    // A workout's children are not all set blocks: a note the user typed under
    // an entry is one, and in a child-backed workspace so is every property
    // row. Filter on the type before deciding anything.
    // The DISPLAY-visible view. `childrenOf` returns every row by default,
    // and in a child-backed workspace that includes each block's property
    // field rows — so "has children" and "holds something that isn't a set"
    // would both be true of essentially every block, refusing finishes that
    // are fine and keeping every skipped lift as an empty entry in the record.
    const children = await tx.childrenOf(workoutId, undefined, {hidePropertyChildren: true})
    const entries = children.filter(row => hasBlockType(row, EXERCISE_ENTRY_TYPE))
    // Children but no entries among them is not "an empty session" — it is a
    // type read that came back wrong, and the plan it produces prunes
    // EVERYTHING. This is the one place in the extension where a misread
    // deletes data rather than showing less, so it refuses instead.
    // An untyped child that owns set blocks is an ENTRY whose type tag is
    // missing, not a note. Finishing around it marks the workout done while
    // that lift and its open todo sets stay behind — absent from the record
    // `buildHistory` assembles, stranded in the agenda forever. A partial
    // misread is the dangerous one precisely because it doesn't look like a
    // misread; only the whole session is worth deciding about, so refuse.
    const untypedWithSets: string[] = []
    for (const child of children) {
      if (hasBlockType(child, EXERCISE_ENTRY_TYPE)) continue
      // The child ITSELF may be a set that was outdented up here. A set has no
      // children, so looking only at its descendants missed it entirely and
      // Finish completed around a live, possibly open todo that the record
      // never mentions.
      if (isSetLike(child)) {
        untypedWithSets.push(child.id)
        continue
      }
      // All the way down, like the entry-level check: a typed entry beside it
      // keeps the blanket guard quiet, so a set two notes deep under the
      // WORKOUT finished clean and stayed live.
      if (await holdsSetLike(tx, child.id)) untypedWithSets.push(child.id)
    }
    if (untypedWithSets.length > 0 || (children.length > 0 && entries.length === 0)) {
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
    /** Notes that turn out to have a SET indented under them. The workout
     *  level already refuses over this shape one level up; the same thing
     *  under a lift was classified as "not a set" and never looked into, so
     *  Finish completed around a live set — possibly an open todo — that the
     *  record never mentions, because `buildHistory` groups sets by their
     *  direct exercise parent. */
    const buriedSets: string[] = []
    /** Set blocks carrying no `strength:completedAt`. Read off the BLOCK
     *  rather than off `FinishEntry`, which projects only what the pruning
     *  decision needs — a projection that happens to carry the field today is
     *  not the same as the block saying so. */
    const untimed = new Set<string>()
    for (const entry of entries) {
      const entryChildren = await tx.childrenOf(entry.id, undefined, {hidePropertyChildren: true})
      const sets: typeof entryChildren = []
      let others = 0
      for (const child of entryChildren) {
        // Tagged as a set, or carrying a set's own numbers — a set whose tag
        // went missing is still a set. Excluding it finished the workout
        // around it: absent from the record `buildHistory` assembles, and — if
        // it was still open — left as a todo under a completed session,
        // unreachable forever. Repaired rather than refused, because the tag
        // is the only thing wrong and the user asked to finish.
        if (!hasBlockType(child, SET_TYPE) && !isSetLike(child)) {
          others += 1
          if (await holdsSetLike(tx, child.id)) buriedSets.push(child.id)
          continue
        }
        // BOTH types, as materialization writes them, and for whatever it is
        // missing — being tagged `strength-set` is no reason to skip the todo
        // repair. Done-ness is read off the raw `status` property, so a set
        // that lost only `todo` still counts here and gets KEPT: it would then
        // sit in the finished record outside every native todo query,
        // rendering as no checkbox, with no later pass to repair it.
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
      // Refuse rather than repair, exactly as the workout level does: where
      // the user meant a set to sit is a question about their log, and
      // finishing is the one operation here that PRUNES.
      throw new Error(
        `finishWorkout: workout ${workoutId} has ${buriedSets.length} set(s) buried under a note `
        + '— refusing to finish, since that would leave logged work out of the record.',
      )
    }
    const plan = finishPlan(workoutId, exercises)

    // Subtree deletes, not `tx.delete`: a set block is a normal block, so a
    // note typed under it — and, in a child-backed workspace, its own property
    // rows — would otherwise stay live under a tombstone.
    //
    // Which is exactly why an entry holding anything that ISN'T a set is
    // emptied rather than removed. "No accepted sets" is read off the type
    // tag, and a tag can go missing — that is the same misread the guard above
    // refuses at the workout level, and one level down it takes the user's own
    // notes with it. Leaving the entry costs an empty row in the record;
    // removing it is unrecoverable.
    for (const exId of plan.removeExerciseIds) {
      if (!holdsMore.has(exId)) {
        await tx.run(deleteBlock, {id: exId})
        continue
      }
      for (const set of exercises.find(entry => entry.id === exId)?.sets ?? []) {
        await tx.run(deleteBlock, {id: set.id})
      }
    }
    // One stamp for the whole session, read once: every set kept by this
    // finish that has no time of its own gets it. A set ticked from the
    // OUTLINE went through the native todo checkbox, which writes the todo
    // status and nothing else — so a session logged entirely that way carries
    // no `strength:completedAt` anywhere, and `compareRecords` then has
    // nothing to place it by among the day's other sessions. The finish moment
    // is not when the set was performed, but it IS on the right side of every
    // other session that day, which is the only thing this number decides.
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
    return 'finished' as const
  }, {scope: ChangeScope.BlockDefault, description: 'Finish workout'})
}

/** Delete an abandoned in-progress workout and its whole subtree.
 *
 *  Takes the WORKOUT id and cascades, rather than a list the caller
 *  assembled from its draft: the live workout can hold blocks the draft no
 *  longer knows about (the `or`-group option you switched away from), and
 *  those would otherwise stay live — open todo sets under a tombstoned
 *  workout. */
/** Throw tonight's session away — the one write here that destroys, and so
 *  the one that has to be surest of what it is looking at.
 *
 *  `'gone'` means it refused: the workout is not there, or it is no longer
 *  in progress. Discard is enabled from whatever the view last rendered, and
 *  a peer's finish can land in the gap between that render and the click —
 *  deleting unconditionally then tombstoned a COMPLETED session and every set
 *  recorded in it, from a button that had merely gone stale. Every other write
 *  in this file re-reads inside its own transaction for the same reason; this
 *  one had the most to lose by not doing it. The caller says so on screen
 *  rather than reporting a discard that did not happen. */
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

/** Record which option of an `or`-group the user is now tracking.
 *
 *  One block per answered group, under the settings block, upserted — so
 *  switching back and forth edits the same block instead of growing a log.
 *  Both ends are refs, which is the point: the group and the chosen option
 *  each show this in their backlinks, so "what am I tracking in this slot?"
 *  is answerable from the plan outline itself, and an option that gets
 *  deleted leaves a visible dangling link rather than a map entry that
 *  silently stops matching. */
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

// ──── one-shot migration of the first version's shape ────

export interface LegacyMigrationReport {
  /** Entries whose JSON sets became set blocks. */
  converted: number
  /** Set blocks written. */
  sets: number
  /** Workouts given an explicit `done` status they were missing. */
  stamped: number
  /** Entries given a `strength:occurrence`, because their lift was logged
   *  more than once in that session and nothing said which row was which. */
  numbered: number
  /** Entries deliberately left alone, so the report says what was NOT done
   *  as loudly as what was. `unreadable` is the one worth looking at: the
   *  cell is there and does not read as a list of sets. */
  skipped: {entryId: string; reason: 'has-set-blocks' | 'no-legacy-sets' | 'unreadable'}[]
}

/** What makes two legacy entries "the same lift" — the plan block where one
 *  is named, else the lift's name. Same precedence the matcher and the
 *  progression lookup use; only the spelling is local, because a legacy entry
 *  has no `occurrence` to key with yet. */
const legacyLiftKey = (entry: BlockData): string =>
  typeof entry.properties[FIELD.definition] === 'string'
    ? entry.properties[FIELD.definition] as string
    : typeof entry.properties[FIELD.exercise] === 'string'
      ? entry.properties[FIELD.exercise] as string
      : entry.content

/** Convert the sessions this extension logged in its first shape — a lift's
 *  sets in one `strength:sets` JSON cell — into the block-per-set tree
 *  everything reads now.
 *
 *  Safe to run twice. An entry that already has set blocks is skipped, and
 *  the blocks it writes are addressed by the SAME derived identity the live
 *  path uses, so a later write adopts them rather than building a second set
 *  of rows beside them.
 *
 *  It does NOT delete the legacy cell. That cell is the only other copy of
 *  this history, and a migration that removes its own source leaves nothing
 *  to check the result against (or to re-run from, if the conversion turns
 *  out to be wrong). It costs one stale property per entry and buys a
 *  recovery path; `audit-extension` will keep mentioning it, which is the
 *  correct amount of noise for data nothing reads any more.
 *
 *  One transaction, so the whole thing is one undo step. */
export const migrateLegacyEntries = async (
  repo: Repo,
  pageId: string,
): Promise<LegacyMigrationReport> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
    const report: LegacyMigrationReport = {converted: 0, sets: 0, stamped: 0, numbered: 0, skipped: []}

    for (const workout of await tx.childrenOf(pageId, undefined, {hidePropertyChildren: true})) {
      if (!hasBlockType(workout, WORKOUT_TYPE)) continue
      const entries = await tx.childrenOf(workout.id, undefined, {hidePropertyChildren: true})
      let touched = false

      // Which occurrence each entry is, for the lifts a session logged TWICE.
      //
      // Sibling order is the answer, and here it is evidence rather than a
      // guess: the first writer appended one child per draft exercise, in
      // draft order, and `childrenOf` returns `(order_key, id)`. Without the
      // number, `lastEntryFor` asked for occurrence 1, found no entry claiming
      // it, and fell back to the first occurrence-less candidate — so BOTH
      // rows of the next prescription progressed off the heavy row's load.
      //
      // Only for lifts that actually repeat. A lift logged once must stay
      // occurrence-LESS: that absence is what lets a lookup for any occurrence
      // fall back to it, which is the whole reason records written before the
      // property existed still progress at all.
      const seen = new Map<string, number>()
      const repeats = new Map<string, number>()
      for (const entry of entries) {
        if (!hasBlockType(entry, EXERCISE_ENTRY_TYPE)) continue
        const key = legacyLiftKey(entry)
        repeats.set(key, (repeats.get(key) ?? 0) + 1)
      }

      for (const entry of entries) {
        if (!hasBlockType(entry, EXERCISE_ENTRY_TYPE)) continue
        // Counted before any skip, so a lift whose FIRST row is unreadable
        // still leaves its second row as occurrence 1 rather than 0.
        const liftKey = legacyLiftKey(entry)
        const nth = seen.get(liftKey) ?? 0
        seen.set(liftKey, nth + 1)
        const children = await tx.childrenOf(entry.id, undefined, {hidePropertyChildren: true})
        // Already migrated (or logged in the current shape). Checked on the
        // BLOCKS rather than on a marker property, because the blocks are the
        // thing a second run would duplicate.
        if (children.some(isSetLike)) {
          report.skipped.push({entryId: entry.id, reason: 'has-set-blocks'})
          continue
        }
        const sets = readLegacySets(entry.properties[LEGACY_SETS_PROP])
        if (sets === undefined) {
          report.skipped.push({
            entryId: entry.id,
            reason: entry.properties[LEGACY_SETS_PROP] === undefined ? 'no-legacy-sets' : 'unreadable',
          })
          continue
        }

        const unit = typeof entry.properties[FIELD.unit] === 'string'
          ? entry.properties[FIELD.unit] as string
          : 'lb'
        for (const [index, set] of sets.entries()) {
          const spec = setSpec(entry.id, set, index, unit, typeSnapshot)
          const outcome = await getOrCreateTypedChild(repo, tx, {
            identity: setIdentity(entry.id, index),
            // Nothing set-like is under this entry — that is the guard above.
            // So the only things this id can be holding are the TOMBSTONE of a
            // set migrated here once and since deleted, or a block that is not
            // a set at all. Neither is this set, and there is no second id to
            // derive, so the answer is the same as everywhere else in this
            // file: mint.
            adoptable: block => block.parentId === entry.id && isSetLike(block),
            ...spec,
          })
          // Counted only for a set that actually landed. Incrementing on an
          // outcome we never read meant an entry whose migrated blocks had all
          // been deleted reported `converted` and `sets` — and got its workout
          // stamped `done` on the strength of it — while writing nothing at
          // all, so re-running the recovery action said it had worked and the
          // session stayed missing from progression history.
          if (outcome.status === 'taken') await createTypedChild(repo, tx, spec)
          report.sets += 1
        }
        if ((repeats.get(liftKey) ?? 0) > 1 && entry.properties[FIELD.occurrence] === undefined) {
          await tx.setProperty(entry.id, occurrenceProp, nth)
          report.numbered += 1
        }
        report.converted += 1
        touched = true
      }

      // Say outright what every reader already infers. The first version
      // never wrote a status at all: `buildHistory` takes that as "not
      // in-progress, so it is history" and `buildLiveWorkouts` takes it as
      // "not live" — agreeing, but by omission. A record that states it is
      // done cannot be misread by the next thing that looks at it.
      if (touched && workout.properties[FIELD.status] === undefined) {
        await tx.setProperty(workout.id, statusProp, 'done')
        report.stamped += 1
      }
    }
    return report
  }, {scope: ChangeScope.BlockDefault, description: 'Migrate legacy strength log'})
}

// ──── layoff + shoulder writes (unchanged) ────

export const writeLayoff = async (
  repo: Repo,
  workspaceId: string,
  pageId: string,
  record: Omit<LayoffRecord, 'id'>,
): Promise<string> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
    const id = await tx.run(createChild, {
      parentId: pageId,
      content: `Layoff · ${record.days}-day gap → ${Math.round(record.pct * 100)}% (${record.tierId})`,
      position: {kind: 'first'},
    })
    await tx.setProperty(id, layoffFromProp, dayToDate(record.from))
    await tx.setProperty(id, layoffToProp, dayToDate(record.to))
    await tx.setProperty(id, layoffDaysProp, record.days)
    await tx.setProperty(id, layoffTierProp, record.tierId)
    await tx.setProperty(id, layoffPctProp, record.pct)
    await repo.addTypeInTx(tx, id, 'strength-layoff', {}, typeSnapshot)
    return id
  }, {scope: ChangeScope.BlockDefault, description: 'Record layoff'})
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
