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

import type {ExerciseEntryIds, MaterializedWorkout} from '../km/store'
import type {DraftExercise} from './draft'

/** Ids a create handed back, to be stamped into the draft. Absent from a
 *  result when the create landed after a reseed — see `reset`. */
export type IdPatch =
  | {kind: 'workout'; workout: MaterializedWorkout}
  | {kind: 'exercise'; exIdx: number; entry: ExerciseEntryIds}

export type {ExerciseEntryIds}

export interface ResolvedWrite {
  /** The block to write this set to. Undefined when nothing could be
   *  resolved (no workout id, and creating one wasn't possible). */
  blockId?: string
  patch?: IdPatch
}

/** The writes this coordinator orchestrates but never performs. */
export interface WriteEffects {
  createWorkout(draft: readonly DraftExercise[]): Promise<MaterializedWorkout>
  createExercise(workoutId: string, exercise: DraftExercise, occurrence: number): Promise<ExerciseEntryIds>
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
  /** Which generation is current. A long operation (Finish) captures this up
   *  front and bails if it moved — the draft it was working from is gone. */
  generation(): number
  /** The view reseeded. Two identifiers, because a reseed means several very
   *  different things and only one of them is "a different workout":
   *
   *   - `slot` — the day + session being logged. ONLY a change here means a
   *     different workout, so only here may a workout id be dropped. A
   *     reseed that arrives with no live workout (the query hasn't caught up,
   *     or the config load shifted the day) must NOT forget the workout this
   *     coordinator just created — doing that is what started a second one.
   *   - `shape` — which exercises are being logged. A change (an `or`-group
   *     switched, the plan loaded) invalidates the positional ids in
   *     `materialized` and starts a new generation, but the workout is the
   *     same one and keeps being written to. */
  reset(workoutId: string | null, slot: string, shape: string): void
  /** The workout was discarded. Results from creates already in flight stop
   *  yielding a block to write to — those blocks are about to be (or already
   *  are) tombstoned, and writing into them leaves live todo sets under a
   *  deleted parent. Distinct from `reset`, where a write into the session
   *  you just left is still the right thing. */
  abandon(): void
  /** Resolve — and create, if needed — the block for one set. */
  resolveSet(
    draft: readonly DraftExercise[],
    exIdx: number,
    setIdx: number,
    effects: WriteEffects,
  ): Promise<ResolvedWrite>
}

export const createWriteCoordinator = (
  initialWorkoutId: string | null = null,
  initialSlot = '',
  initialShape = '',
): WriteCoordinator => {
  let generation = 0
  let abandonedThrough = -1
  let workoutId = initialWorkoutId
  let slot = initialSlot
  let shape = initialShape
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
    if (!creatingWorkout) {
      // Drop a FAILED create from the cache, or every later tap awaits the
      // same rejection and the create is never retried — the user logs a
      // whole session against a workout that was never made.
      creatingWorkout = effects.createWorkout(draft).catch(error => {
        if (at === generation) creatingWorkout = null
        throw error
      })
    }
    const value = await creatingWorkout
    return {value, stale: at !== generation}
  }

  /** Same, per switched-in exercise. */
  const createExerciseOnce = async (
    key: string,
    exercise: DraftExercise,
    occurrence: number,
    forWorkoutId: string,
    effects: WriteEffects,
  ): Promise<{value: ExerciseEntryIds; stale: boolean}> => {
    const at = generation
    const running = creatingExercises.get(key)
      ?? effects.createExercise(forWorkoutId, exercise, occurrence).catch(error => {
        if (at === generation && creatingExercises.get(key) === running) creatingExercises.delete(key)
        throw error
      })
    creatingExercises.set(key, running)
    const value = await running
    return {value, stale: at !== generation}
  }

  return {
    workoutId: () => workoutId,
    materialized: () => materialized,
    generation: () => generation,

    reset(nextWorkoutId, nextSlot, nextShape) {
      if (nextSlot !== slot) {
        // A different day/session: a different workout, so everything here is
        // about something else now.
        generation += 1
        slot = nextSlot
        shape = nextShape
        workoutId = nextWorkoutId
        materialized = null
        creatingWorkout = null
        creatingExercises = new Map()
        return
      }

      // Same slot. Adopt a live id if one turned up, but never fall back to
      // null: no live workout usually means the query hasn't caught up with
      // the one we just made, and forgetting it starts a duplicate.
      workoutId = nextWorkoutId ?? workoutId
      if (nextShape === shape) return

      // The exercise list changed under us. `materialized` is positional, so
      // it no longer describes this draft, and an in-flight create's ids
      // would land on the wrong rows — new generation. The workout itself is
      // unchanged and keeps being written to.
      generation += 1
      shape = nextShape
      materialized = null
      creatingWorkout = null
      creatingExercises = new Map()
    },

    abandon() {
      abandonedThrough = generation
      generation += 1
      slot = ''
      workoutId = null
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
        const at = generation
        const {value, stale} = await createWorkoutOnce(draft, effects)
        if (!stale) {
          workoutId = value.workoutId
          materialized = value
        }
        if (at <= abandonedThrough) return {}
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
      const at = generation
      const {value, stale} = await createExerciseOnce(
        exerciseKey(exercise, exIdx),
        exercise,
        // Which row of this lift THIS is, counted over the SAME array we are
        // indexing. Deriving it from the prescription instead meant two
        // sources of truth for one index — the exact shape of the bug the
        // occurrence counter exists to prevent.
        draft.slice(0, exIdx).filter(e => (e.defId ?? e.exercise) === (exercise.defId ?? exercise.exercise)).length,
        workoutId,
        effects,
      )
      // Discarded while this was in flight: the blocks it just made are
      // children of a workout that is being deleted, so writing into them
      // would strand live todo sets under a tombstone.
      if (at <= abandonedThrough) return {}
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
