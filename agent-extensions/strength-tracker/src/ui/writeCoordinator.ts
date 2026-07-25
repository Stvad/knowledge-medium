/** Where does this set get written, and what has to be created first?
 *
 *  That one question caused every logging bug this extension has had. The
 *  answer depends on state that used to live in React refs inside the view —
 *  which meant it could only be exercised by clicking, and so its edge cases
 *  were found by reviewers instead of by tests:
 *
 *   - the workout doesn't exist yet (first edit of the night)
 *   - it's being created RIGHT NOW by a tap half a second ago
 *   - it was created moments ago, and this caller still holds the block-less
 *     snapshot it started from ("accept all" hands every set the same one)
 *   - the exercise was switched in mid-session and has no blocks
 *   - the session was switched while a create was in flight, so the ids that
 *     came back belong to a workout this draft is no longer editing
 *
 *  This module owns that decision and the de-duplication of in-flight
 *  creates. It performs no writes itself: effects are passed in, so the whole
 *  thing runs in plain node against fakes. The view keeps the React parts —
 *  applying the returned id patches to its draft.
 */

import type {MaterializedWorkout} from '../km/store'
import type {DraftExercise} from './draft'

/** Ids a create handed back, to be stamped into the draft. Absent from a
 *  result when the create landed after a reseed — see `reset`. */
export type IdPatch =
  | {kind: 'workout'; workout: MaterializedWorkout}
  | {kind: 'exercise'; exIdx: number; entry: ExerciseEntryIds}

export interface ExerciseEntryIds {
  id: string
  setIds: string[]
}

export interface ResolvedWrite {
  /** The block to write this set to. Undefined when nothing could be
   *  resolved (no workout id, and creating one wasn't possible). */
  blockId?: string
  patch?: IdPatch
}

/** The writes this coordinator orchestrates but never performs. */
export interface WriteEffects {
  createWorkout(draft: readonly DraftExercise[]): Promise<MaterializedWorkout>
  createExercise(workoutId: string, exercise: DraftExercise): Promise<ExerciseEntryIds>
}

/** Identity of an exercise ROW, so switching the same slot twice doesn't
 *  reuse the first option's create. */
const exerciseKey = (exercise: DraftExercise, exIdx: number): string =>
  `${exIdx}:${exercise.defId ?? exercise.exercise}`

export interface WriteCoordinator {
  /** The workout being logged into, once it exists. */
  workoutId(): string | null
  /** Ids from this session's create, if the workout was created here rather
   *  than adopted from a live query. */
  materialized(): MaterializedWorkout | null
  /** Start a new generation: the view reseeded (session/day switch, plan
   *  change, live structure change). Creates still in flight keep their ids
   *  to themselves rather than pointing the new draft at the old workout. */
  reset(workoutId: string | null): void
  /** Resolve — and create, if needed — the block for one set. */
  resolveSet(
    draft: readonly DraftExercise[],
    exIdx: number,
    setIdx: number,
    effects: WriteEffects,
  ): Promise<ResolvedWrite>
}

export const createWriteCoordinator = (initialWorkoutId: string | null = null): WriteCoordinator => {
  let generation = 0
  let workoutId = initialWorkoutId
  let materialized: MaterializedWorkout | null = null
  let creatingWorkout: Promise<MaterializedWorkout> | null = null
  let creatingExercises = new Map<string, Promise<ExerciseEntryIds>>()

  /** Start the workout create, or join the one already running. The promise
   *  is stored BEFORE anything awaits, so two taps in the same tick share it
   *  instead of racing two workouts into existence. */
  const createWorkoutOnce = async (
    draft: readonly DraftExercise[],
    effects: WriteEffects,
  ): Promise<{value: MaterializedWorkout; stale: boolean}> => {
    const at = generation
    if (!creatingWorkout) creatingWorkout = effects.createWorkout(draft)
    const value = await creatingWorkout
    return {value, stale: at !== generation}
  }

  /** Same, per switched-in exercise. */
  const createExerciseOnce = async (
    key: string,
    exercise: DraftExercise,
    forWorkoutId: string,
    effects: WriteEffects,
  ): Promise<{value: ExerciseEntryIds; stale: boolean}> => {
    const at = generation
    const running = creatingExercises.get(key) ?? effects.createExercise(forWorkoutId, exercise)
    creatingExercises.set(key, running)
    const value = await running
    return {value, stale: at !== generation}
  }

  return {
    workoutId: () => workoutId,
    materialized: () => materialized,

    reset(nextWorkoutId) {
      generation += 1
      workoutId = nextWorkoutId
      materialized = null
      creatingWorkout = null
      creatingExercises = new Map()
    },

    async resolveSet(draft, exIdx, setIdx, effects) {
      const exercise = draft[exIdx]
      if (!exercise) return {}
      const set = exercise.sets[setIdx]
      if (!set) return {}

      // Already has a block: the common case after the first edit.
      if (set.blockId) return {blockId: set.blockId}

      if (!workoutId) {
        const {value, stale} = await createWorkoutOnce(draft, effects)
        if (!stale) {
          workoutId = value.workoutId
          materialized = value
        }
        return {
          blockId: value.exercises[exIdx]?.setIds[setIdx],
          ...(stale ? {} : {patch: {kind: 'workout' as const, workout: value}}),
        }
      }

      // Created moments ago in this same batch: the caller's snapshot predates
      // those ids, so consult them before concluding anything is missing —
      // otherwise "accept all" creates the exercise a second time.
      const fromCreate = materialized?.exercises[exIdx]?.setIds[setIdx]
      if (fromCreate) return {blockId: fromCreate}

      // The workout exists but this exercise has no blocks: switched in
      // mid-session.
      const {value, stale} = await createExerciseOnce(
        exerciseKey(exercise, exIdx),
        exercise,
        workoutId,
        effects,
      )
      return {
        blockId: value.setIds[setIdx],
        ...(stale ? {} : {patch: {kind: 'exercise' as const, exIdx, entry: value}}),
      }
    },
  }
}

/** Stamp created ids into a draft. Pure, and never overwrites an id the
 *  draft already has — a set that acquired its block another way (a live
 *  query landing first) keeps it. */
export const applyIdPatch = (
  draft: readonly DraftExercise[],
  patch: IdPatch,
): DraftExercise[] => {
  if (patch.kind === 'workout') {
    return draft.map((ex, i) => ({
      ...ex,
      blockId: ex.blockId ?? patch.workout.exercises[i]?.id,
      sets: ex.sets.map((s, j) => ({...s, blockId: s.blockId ?? patch.workout.exercises[i]?.setIds[j]})),
    }))
  }
  return draft.map((ex, i) => (i !== patch.exIdx ? ex : {
    ...ex,
    blockId: ex.blockId ?? patch.entry.id,
    sets: ex.sets.map((s, j) => ({...s, blockId: s.blockId ?? patch.entry.setIds[j]})),
  }))
}
