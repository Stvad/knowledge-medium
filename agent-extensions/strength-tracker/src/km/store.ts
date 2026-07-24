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
import {createTypedChild} from '@/data/typedRecords.js'
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
import {buildAltChoices} from './history'

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
export interface MaterializedWorkout {
  workoutId: string
  exercises: {id: string; setIds: string[]}[]
}

const sessionLabel = (session: SessionType): string =>
  session === 'mini' ? 'Mini day' : `Session ${session}`

// No ✓ prefix — the composed todo checkbox conveys done-ness.
const setContent = (set: SetDraft, unit: string): string => {
  const side = set.side ? `${set.side} ` : ''
  return `${side}${set.weight}${unit} × ${set.reps}`
}

const todoStatus = (done: boolean): 'open' | 'done' => (done ? 'done' : 'open')

/** One exercise entry + its set blocks, inside the caller's transaction.
 *  Shared by "start the session" and "add this lift mid-session", so an
 *  entry written either way is identical. */
const writeExercise = async (
  repo: Repo,
  tx: Tx,
  workoutId: string,
  ex: ExerciseDraft,
  typeSnapshot: ReturnType<Repo['snapshotTypeRegistries']>,
): Promise<{id: string; setIds: string[]}> => {
  const exId = await tx.run(createChild, {parentId: workoutId, content: ex.exercise})
  await tx.setProperty(exId, exerciseProp, ex.exercise)
  await tx.setProperty(exId, definitionProp, ex.definitionId)
  await tx.setProperty(exId, unitProp, ex.unit)
  if (ex.prescribedWeight !== undefined) await tx.setProperty(exId, prescribedWeightProp, ex.prescribedWeight)
  if (ex.prescribedSets !== undefined) await tx.setProperty(exId, prescribedSetsProp, ex.prescribedSets)
  await repo.addTypeInTx(tx, exId, EXERCISE_ENTRY_TYPE, {}, typeSnapshot)

  const setIds: string[] = []
  for (const s of ex.sets) {
    const setId = await tx.run(createChild, {parentId: exId, content: setContent(s, ex.unit)})
    await tx.setProperty(setId, weightProp, s.weight)
    await tx.setProperty(setId, repsProp, s.reps)
    await tx.setProperty(setId, rpeProp, s.rpe)
    await tx.setProperty(setId, sideProp, s.side)
    await tx.setProperty(setId, completedAtProp, s.completedAt)
    await repo.addTypeInTx(tx, setId, SET_TYPE, {}, typeSnapshot)
    await repo.addTypeInTx(tx, setId, TODO_TYPE, {}, typeSnapshot)
    await tx.setProperty(setId, todoStatusProp, todoStatus(s.done))
    setIds.push(setId)
  }
  return {id: exId, setIds}
}

// ──── live logging writes ────

/** Create the workout + one child per exercise + one grandchild per set, all
 *  in a single transaction (so it lands and undoes atomically). The workout is
 *  born `in-progress`; the set blocks carry whatever the draft already holds
 *  (usually the pre-filled prescription, `done: false`). Returns the ids so
 *  the caller can write set edits straight to their blocks. */
export const materializeWorkout = async (
  repo: Repo,
  workspaceId: string,
  pageId: string,
  draft: WorkoutDraft,
): Promise<MaterializedWorkout> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
    const workoutId = await tx.run(createChild, {
      parentId: pageId,
      content: `${sessionLabel(draft.session)} · ${draft.day}`,
      position: {kind: 'first'},
    })
    await tx.setProperty(workoutId, sessionProp, draft.session)
    await tx.setProperty(workoutId, dateProp, dayToDate(draft.day))
    await tx.setProperty(workoutId, statusProp, 'in-progress')
    await repo.addTypeInTx(tx, workoutId, WORKOUT_TYPE, {}, typeSnapshot)

    const exercises: {id: string; setIds: string[]}[] = []
    for (const ex of draft.exercises) {
      exercises.push(await writeExercise(repo, tx, workoutId, ex, typeSnapshot))
    }
    return {workoutId, exercises}
  }, {scope: ChangeScope.BlockDefault, description: `Start ${sessionLabel(draft.session)}`})
}

/** Add ONE exercise (and its pre-filled sets) to a workout that already
 *  exists. This is the mid-session case: you switch an `or`-group to the
 *  other option because your shoulder complained, and the option you switched
 *  to has no blocks yet. Same shape as `materializeWorkout` writes, so the
 *  entry is indistinguishable from one created at the start. */
export const materializeExercise = async (
  repo: Repo,
  workoutId: string,
  ex: ExerciseDraft,
): Promise<{id: string; setIds: string[]}> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => writeExercise(repo, tx, workoutId, ex, typeSnapshot),
    {scope: ChangeScope.BlockDefault, description: `Add ${ex.exercise}`})
}

/** Persist one set's current state to its block (in place). Writes the full
 *  set so the block always mirrors the UI, and refreshes the readable content
 *  line. */
export const writeSet = async (
  repo: Repo,
  setId: string,
  set: SetDraft,
  unit: string,
): Promise<void> => {
  await repo.tx(async tx => {
    await tx.update(setId, {content: setContent(set, unit)})
    await tx.setProperty(setId, weightProp, set.weight)
    await tx.setProperty(setId, repsProp, set.reps)
    await tx.setProperty(setId, rpeProp, set.rpe)
    await tx.setProperty(setId, sideProp, set.side)
    await tx.setProperty(setId, completedAtProp, set.completedAt)
    await tx.setProperty(setId, todoStatusProp, todoStatus(set.done))
  }, {scope: ChangeScope.BlockDefault, description: 'Log set'})
}

/** Instructions for finishing a workout: which sets to keep (with the
 *  exercise's derived working weight) and which un-accepted rows to prune. */
export interface FinishPlan {
  workoutId: string
  /** Exercises that kept at least one done set. */
  keep: {exerciseId: string; workingWeight: number | undefined; removeSetIds: readonly string[]}[]
  /** Exercises with no done set — removed wholesale. */
  removeExerciseIds: readonly string[]
}

/** Flip the workout to `done`, stamp each kept exercise's working weight, and
 *  prune the un-accepted sets / empty exercises so the saved record shows only
 *  what was actually performed. One transaction. */
export const finishWorkout = async (repo: Repo, plan: FinishPlan): Promise<void> => {
  await repo.tx(async tx => {
    // Subtree delete, not `tx.delete`: a skipped exercise still has its
    // pre-filled set blocks, and those are todo-typed. Tombstoning only the
    // parent would leave them live — stray open todos under a deleted block.
    for (const exId of plan.removeExerciseIds) await tx.run(deleteBlock, {id: exId})
    for (const ex of plan.keep) {
      for (const setId of ex.removeSetIds) await tx.delete(setId)
      await tx.setProperty(ex.exerciseId, workingWeightProp, ex.workingWeight)
    }
    await tx.setProperty(plan.workoutId, statusProp, 'done')
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
