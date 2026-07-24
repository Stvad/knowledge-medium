/** Writing the strength blocks.
 *
 *  The read side lives in the pure `history.ts` module (re-exported below);
 *  writes go through `repo.tx`, where `tx.setProperty` handles codec
 *  encoding for us.
 */

import {ChangeScope} from '@/data/api/index.js'
import {createChild} from '@/data/mutators.js'
import type {Repo} from '@/data/repo.js'

import type {LayoffRecord, SessionType} from '../engine/types'
import {workingWeight} from '../engine/progression'
import {
  EXERCISE_ENTRY_TYPE,
  LAYOFF_TYPE,
  WORKOUT_TYPE,
  dateProp,
  exerciseProp,
  layoffDaysProp,
  layoffFromProp,
  layoffPctProp,
  layoffTierProp,
  layoffToProp,
  prescribedSetsProp,
  prescribedWeightProp,
  sessionProp,
  setsProp,
  unitProp,
  workingWeightProp,
} from './schema'
import type {StoredSet} from './fields'
import {dayToDate} from './day'

export {buildHistory, buildLayoffs, type RowLike} from './history'

// ──── writes ────

export interface ExerciseDraft {
  exercise: string
  unit: string
  prescribedWeight?: number
  prescribedSets?: number
  sets: readonly StoredSet[]
}

export interface WorkoutDraft {
  day: string
  session: SessionType
  exercises: readonly ExerciseDraft[]
}

const sessionLabel = (session: SessionType): string =>
  session === 'mini' ? 'Mini day' : `Session ${session}`

const setSummary = (sets: readonly StoredSet[]): string => {
  if (sets.length === 0) return ''
  const w = workingWeight({exercise: '', sets})
  const reps = sets.map(s => s.reps).join(', ')
  return w !== undefined && w > 0 ? ` — ${w} × ${reps}` : ` — ${reps}`
}

/** Write a whole workout — the parent block and one child per logged
 *  exercise — in a single transaction, so it lands (and undoes) as a unit
 *  and never syncs a half-recorded session. */
export const writeWorkout = async (
  repo: Repo,
  workspaceId: string,
  pageId: string,
  draft: WorkoutDraft,
): Promise<string> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
    const workoutId = await tx.run(createChild, {
      parentId: pageId,
      content: `${sessionLabel(draft.session)} · ${draft.day}`,
      position: {kind: 'first'},
    })
    await tx.setProperty(workoutId, sessionProp, draft.session)
    await tx.setProperty(workoutId, dateProp, dayToDate(draft.day))
    await repo.addTypeInTx(tx, workoutId, WORKOUT_TYPE, {}, typeSnapshot)

    for (const ex of draft.exercises) {
      const entryId = await tx.run(createChild, {
        parentId: workoutId,
        content: `${ex.exercise}${setSummary(ex.sets)}`,
      })
      await tx.setProperty(entryId, exerciseProp, ex.exercise)
      await tx.setProperty(entryId, setsProp, ex.sets)
      await tx.setProperty(entryId, unitProp, ex.unit)
      await tx.setProperty(entryId, workingWeightProp, workingWeight({exercise: ex.exercise, sets: ex.sets}))
      if (ex.prescribedWeight !== undefined) await tx.setProperty(entryId, prescribedWeightProp, ex.prescribedWeight)
      if (ex.prescribedSets !== undefined) await tx.setProperty(entryId, prescribedSetsProp, ex.prescribedSets)
      await repo.addTypeInTx(tx, entryId, EXERCISE_ENTRY_TYPE, {}, typeSnapshot)
    }
    return workoutId
  }, {scope: ChangeScope.BlockDefault, description: `Log ${sessionLabel(draft.session)}`})
}

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
    await repo.addTypeInTx(tx, id, LAYOFF_TYPE, {}, typeSnapshot)
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
    // 'todo' is the todo plugin's type id; addType materialises its default
    // `status: open`. If that plugin is disabled the block is still a valid,
    // visible action item — it just won't render a checkbox.
    await repo.addTypeInTx(tx, id, 'todo', {}, typeSnapshot)
    return id
  }, {scope: ChangeScope.BlockDefault, description: 'Shoulder trigger → consult todo'})
}
