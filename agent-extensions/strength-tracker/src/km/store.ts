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

import {ChangeScope, propertyValue, type Tx} from '@/data/api/index.js'
import {createChild, deleteBlock} from '@/data/mutators.js'
import type {Repo} from '@/data/repo.js'
import {createTypedChild, getOrCreateTypedChild, type DerivedIdentity} from '@/data/typedRecords.js'
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
  sideProp,
  statusProp,
  unitProp,
  weightProp,
  workingWeightProp,
} from './schema'
import {dayToDate} from './day'

export {buildHistory, buildLayoffs, type RowLike} from './history'
import {buildAltChoices, toLiveSet} from './history'
import type {LiveWorkout} from './history'
import {finishPlan, type FinishPlan} from './finish'
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

/** One workout per workspace/day/session. */
const workoutIdentity = (workspaceId: string, day: string, session: SessionType): DerivedIdentity =>
  ({namespace: WORKOUT_NS, key: `${workspaceId}|${day}|${session}`})

/** One entry per lift in a workout — keyed on the plan block where there is
 *  one, so a lift renamed mid-session stays the same entry. `occurrence`
 *  separates two rows of the same lift in one session; without it the second
 *  row would adopt the first row's blocks and they would write over each
 *  other. */
const exerciseIdentity = (workoutId: string, key: string, occurrence: number): DerivedIdentity =>
  ({namespace: EXERCISE_NS, key: occurrence === 0 ? `${workoutId}|${key}` : `${workoutId}|${key}|${occurrence}`})

/** Sets are positional within their entry — including the L/R rows of a
 *  per-side lift, which alternate. */
const setIdentity = (exerciseId: string, index: number): DerivedIdentity =>
  ({namespace: SET_NS, key: `${exerciseId}|${index}`})

/** One set block under an exercise entry, inside the caller's transaction.
 *  Adopts the block already at this position rather than appending a second
 *  one — which is what lets the caller re-run the whole write for a session
 *  that is half-logged and get its existing ids back. */
const writeSetBlock = async (
  repo: Repo,
  tx: Tx,
  exerciseId: string,
  s: SetDraft,
  index: number,
  unit: string,
  typeSnapshot: TypeSnapshot,
): Promise<string> => {
  const {id} = await getOrCreateTypedChild(repo, tx, {
    identity: setIdentity(exerciseId, index),
    parentId: exerciseId,
    content: setContent(s, unit),
    // Composed with the built-in todo: done-ness is the native checkbox.
    types: [SET_TYPE, TODO_TYPE],
    properties: [
      propertyValue(weightProp, s.weight),
      propertyValue(repsProp, s.reps),
      ...(s.rpe !== undefined ? [propertyValue(rpeProp, s.rpe)] : []),
      ...(s.side !== undefined ? [propertyValue(sideProp, s.side)] : []),
      ...(s.completedAt !== undefined ? [propertyValue(completedAtProp, s.completedAt)] : []),
      propertyValue(todoStatusProp, todoStatus(s.done)),
    ],
    typeSnapshot,
  })
  return id
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
  occurrence: number,
  typeSnapshot: TypeSnapshot,
): Promise<ExerciseEntryIds> => {
  const {id: exId} = await getOrCreateTypedChild(repo, tx, {
    identity: exerciseIdentity(workoutId, ex.definitionId ?? ex.exercise, occurrence),
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
    ],
    typeSnapshot,
  })

  const setIds: string[] = []
  for (const [i, s] of ex.sets.entries()) {
    setIds.push(await writeSetBlock(repo, tx, exId, s, i, ex.unit, typeSnapshot))
  }
  return {id: exId, setIds}
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
 *  is not tonight's log, it's this morning's, so the derivation falls through
 *  to the next slot — which is how "I did session A twice today" (or "I
 *  discarded the first attempt") stays representable while staying
 *  deterministic. */
export const startWorkout = async (
  repo: Repo,
  workspaceId: string,
  pageId: string,
  draft: WorkoutDraft,
): Promise<MaterializedWorkout> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
    const workout = await getOrCreateTypedChild(repo, tx, {
      identity: workoutIdentity(workspaceId, draft.day, draft.session),
      parentId: pageId,
      content: `${sessionLabel(draft.session)} · ${draft.day}`,
      position: {kind: 'first'},
      types: [WORKOUT_TYPE],
      properties: [
        propertyValue(sessionProp, draft.session),
        propertyValue(dateProp, dayToDate(draft.day)),
        propertyValue(statusProp, 'in-progress'),
      ],
      adoptable: block => block.properties[FIELD.status] !== 'done',
      typeSnapshot,
    })

    // Two rows of the same lift in one session each need their own entry.
    const occurrences = new Map<string, number>()
    const exercises: ExerciseEntryIds[] = []
    for (const ex of draft.exercises) {
      const key = ex.definitionId ?? ex.exercise
      const occurrence = occurrences.get(key) ?? 0
      occurrences.set(key, occurrence + 1)
      exercises.push(await writeExercise(repo, tx, workout.id, ex, occurrence, typeSnapshot))
    }
    return {workoutId: workout.id, exercises}
  }, {scope: ChangeScope.BlockDefault, description: `Start ${sessionLabel(draft.session)}`})
}

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
  occurrence: number,
): Promise<ExerciseEntryIds> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => writeExercise(repo, tx, workoutId, ex, occurrence, typeSnapshot),
    {scope: ChangeScope.BlockDefault, description: `Add ${ex.exercise}`})
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
): Promise<void> => {
  await repo.tx(async tx => {
    const before = await tx.get(setId)
    if (!before || before.deleted) return
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
  }, {scope: ChangeScope.BlockDefault, description: 'Log set'})
}

/** Does this child carry `typeId`? Reads the raw `types` array. */
const hasType = (row: {properties: Record<string, unknown>}, typeId: string): boolean => {
  const types = row.properties.types
  return Array.isArray(types) && types.includes(typeId)
}

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
export const finishWorkout = async (repo: Repo, workoutId: string): Promise<void> => {
  await repo.tx(async tx => {
    // A workout's children are not all set blocks: a note the user typed under
    // an entry is one, and in a child-backed workspace so is every property
    // row. Filter on the type before deciding anything.
    const entries = (await tx.childrenOf(workoutId)).filter(row => hasType(row, EXERCISE_ENTRY_TYPE))
    const exercises: LiveWorkout['exercises'] = []
    for (const entry of entries) {
      const sets = (await tx.childrenOf(entry.id)).filter(row => hasType(row, SET_TYPE))
      exercises.push({
        id: entry.id,
        exercise: typeof entry.properties[FIELD.exercise] === 'string'
          ? entry.properties[FIELD.exercise] as string
          : entry.content,
        unit: 'lb',
        sets: sets.map(toLiveSet),
      })
    }
    const plan = finishPlan(workoutId, {id: workoutId, day: '', session: 'A', exercises})

    // Subtree deletes, not `tx.delete`: a set block is a normal block, so a
    // note typed under it — and, in a child-backed workspace, its own property
    // rows — would otherwise stay live under a tombstone.
    for (const exId of plan.removeExerciseIds) await tx.run(deleteBlock, {id: exId})
    for (const ex of plan.keep) {
      for (const setId of ex.removeSetIds) await tx.run(deleteBlock, {id: setId})
      await tx.setProperty(ex.exerciseId, workingWeightProp, ex.workingWeight)
    }
    await tx.setProperty(workoutId, statusProp, 'done')
  }, {scope: ChangeScope.BlockDefault, description: 'Finish workout'})
}

/** Delete an abandoned in-progress workout and its whole subtree.
 *
 *  Takes the WORKOUT id and cascades, rather than a list the caller
 *  assembled from its draft: the live workout can hold blocks the draft no
 *  longer knows about (the `or`-group option you switched away from), and
 *  those would otherwise stay live — open todo sets under a tombstoned
 *  workout. */
export const discardWorkout = async (repo: Repo, workoutId: string): Promise<void> => {
  await repo.tx(async tx => {
    await tx.run(deleteBlock, {id: workoutId})
  }, {scope: ChangeScope.BlockDefault, description: 'Discard workout'})
}

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
