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

import {ChangeScope} from '@/data/api/index.js'
import {createChild} from '@/data/mutators.js'
import type {Repo} from '@/data/repo.js'

import type {LayoffRecord, SessionType} from '../engine/types'
import {
  EXERCISE_ENTRY_TYPE,
  SET_TYPE,
  WORKOUT_TYPE,
  altChoicesProp,
  completedAtProp,
  dateProp,
  doneProp,
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

const setContent = (set: SetDraft, unit: string): string => {
  const side = set.side ? `${set.side} ` : ''
  const check = set.done ? '✓ ' : ''
  return `${check}${side}${set.weight}${unit} × ${set.reps}`
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
      const exId = await tx.run(createChild, {parentId: workoutId, content: ex.exercise})
      await tx.setProperty(exId, exerciseProp, ex.exercise)
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
        await tx.setProperty(setId, doneProp, s.done)
        await tx.setProperty(setId, completedAtProp, s.completedAt)
        await repo.addTypeInTx(tx, setId, SET_TYPE, {}, typeSnapshot)
        setIds.push(setId)
      }
      exercises.push({id: exId, setIds})
    }
    return {workoutId, exercises}
  }, {scope: ChangeScope.BlockDefault, description: `Start ${sessionLabel(draft.session)}`})
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
    await tx.setProperty(setId, doneProp, set.done)
    await tx.setProperty(setId, completedAtProp, set.completedAt)
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
    for (const exId of plan.removeExerciseIds) await tx.delete(exId)
    for (const ex of plan.keep) {
      for (const setId of ex.removeSetIds) await tx.delete(setId)
      await tx.setProperty(ex.exerciseId, workingWeightProp, ex.workingWeight)
    }
    await tx.setProperty(plan.workoutId, statusProp, 'done')
  }, {scope: ChangeScope.BlockDefault, description: 'Finish workout'})
}

/** Delete an abandoned in-progress workout and its whole subtree. */
export const discardWorkout = async (repo: Repo, ids: readonly string[]): Promise<void> => {
  if (ids.length === 0) return
  await repo.tx(async tx => {
    for (const id of ids) await tx.delete(id)
  }, {scope: ChangeScope.BlockDefault, description: 'Discard workout'})
}

/** Record which option of an `or`-group the user is now tracking. User state
 *  on the settings block (read-modify-write the choices map), so the plan
 *  outline stays untouched. */
export const writeAltChoice = async (
  repo: Repo,
  settingsBlockId: string,
  groupKey: string,
  exerciseName: string,
): Promise<void> => {
  await repo.tx(async tx => {
    const block = await tx.get(settingsBlockId)
    const current = (block?.properties[altChoicesProp.name] as Record<string, string> | undefined) ?? {}
    await tx.setProperty(settingsBlockId, altChoicesProp, {...current, [groupKey]: exerciseName})
  }, {scope: ChangeScope.UserPrefs, description: 'Choose exercise variant'})
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
