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
import {rowKey, type DraftExercise} from './draft'

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
  createExercise(workoutId: string, exercise: DraftExercise): Promise<ExerciseEntryIds>
}

/** What `reset` actually did — the view needs to tell three very different
 *  reseeds apart and used to do it by mirroring `slot` and `shape` into refs
 *  of its own, i.e. by keeping a second copy of state this module owns. */
export interface ResetOutcome {
  /** A different day/session, so a different workout. */
  slotChanged: boolean
  /** A different set of lifts — same workout, new positional ids. */
  shapeChanged: boolean
}

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
   *     same one and keeps being written to.
   *
   *  Idempotent, and reports what changed — the view calls it on every query
   *  emission and reacts to the transition rather than tracking one itself. */
  reset(workoutId: string | null, slot: string, shape: string, loaded?: boolean): ResetOutcome
  /** The workout was discarded. Results from creates already in flight stop
   *  yielding a block to write to — those blocks are about to be (or already
   *  are) tombstoned, and writing into them leaves live todo sets under a
   *  deleted parent. Distinct from `reset`, where a write into the session
   *  you just left is still the right thing. */
  abandon(): void
  /** The workout was FINISHED. Same clearing as `abandon` — a create still in
   *  flight must not write into a session that is now a record — but a
   *  separate verb because the two differ in what comes next: after a discard
   *  the evening is empty, after a finish it holds a completed workout and the
   *  next session of the same type goes to a new slot.
   *
   *  Without this the coordinator kept the finished workout's id, because a
   *  same-slot `reset(null, …)` deliberately never falls back to null (no live
   *  workout usually means the query is behind). Every later tap then resolved
   *  against a completed session. */
  completed(): void
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
  /** Workouts this coordinator has let go of. Finish and Discard invalidate
   *  the workout, entry and set queries INDEPENDENTLY, so an entry or set
   *  emission can rebuild `live` from a workout row that still reads
   *  `in-progress` before the workout query publishes `done` (or the
   *  deletion). Adopting that id again resurrects a session we are done with:
   *  the Discard button comes back for a logged workout, and later edits route
   *  into released blocks.
   *
   *  Keyed by the SLOT each was released from, because that is the only slot
   *  whose queries can speak for it. Retiring the whole set on any
   *  authoritative absence let an empty session B vouch for session A: finish
   *  A, flip to B, flip back before A's workout query publishes, and A came
   *  straight back — Discard and all. */
  const released = new Map<string, string>()
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

  /** This workout is no longer the one being logged into — it was discarded
   *  or finished. Results from creates still in flight stop yielding a block
   *  to write to: those blocks now belong to a tombstone or to a completed
   *  record, and either way a write into them is wrong. */
  const release = () => {
    if (workoutId !== null) released.set(workoutId, slot)
    abandonedThrough = generation
    generation += 1
    workoutId = null
    materialized = null
    creatingWorkout = null
    creatingExercises = new Map()
  }

  /** Same, per switched-in exercise. */
  const createExerciseOnce = async (
    key: string,
    exercise: DraftExercise,
    forWorkoutId: string,
    effects: WriteEffects,
  ): Promise<{value: ExerciseEntryIds; stale: boolean}> => {
    const at = generation
    const running = creatingExercises.get(key)
      ?? effects.createExercise(forWorkoutId, exercise).catch(error => {
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

    reset(nextWorkoutId, nextSlot, nextShape, loaded = false) {
      // An id stays released only until the queries CONFIRM it is gone. Once
      // they have, a later reappearance is a genuine restore — undoing a
      // discard puts the same workout back, with the same id — and refusing
      // it forever left Discard a no-op and Finish permanently answering
      // "session changed while saving" until a remount. This is the same
      // authoritative-absence signal the overlay uses; before it existed, a
      // lifetime blacklist was the only way to be safe.
      if (loaded && nextWorkoutId === null) {
        for (const [id, releasedFrom] of released) {
          if (releasedFrom === nextSlot) released.delete(id)
        }
      }

      // An id we have RELEASED is not a live id, whatever a lagging query
      // says. Finish and Discard invalidate the workout, entry and set queries
      // independently, so `live` can be rebuilt from a workout row that still
      // reads `in-progress` well after we let go of it — on THIS slot, and
      // equally on a slot the user switched away from and back to before the
      // workout query caught up.
      const offered = nextWorkoutId !== null && released.has(nextWorkoutId) ? null : nextWorkoutId

      if (nextSlot !== slot) {
        // A different day/session: a different workout, so everything here is
        // about something else now.
        generation += 1
        slot = nextSlot
        shape = nextShape
        workoutId = offered
        materialized = null
        creatingWorkout = null
        creatingExercises = new Map()
        return {slotChanged: true, shapeChanged: true}
      }

      // Same slot. Adopt a live id if one turned up, but never fall back to
      // null: no live workout usually means the query hasn't caught up with
      // the one we just made, and forgetting it starts a duplicate.
      workoutId = offered ?? workoutId
      if (nextShape === shape) return {slotChanged: false, shapeChanged: false}

      // The exercise list changed under us. `materialized` is positional, so
      // it no longer describes this draft, and an in-flight create's ids
      // would land on the wrong rows — new generation. The workout itself is
      // unchanged and keeps being written to.
      generation += 1
      shape = nextShape
      materialized = null
      creatingWorkout = null
      creatingExercises = new Map()
      return {slotChanged: false, shapeChanged: true}
    },

    // `slot` is deliberately untouched by both of these. Clearing it made the
    // next same-slot `reset` report `slotChanged`, and the view answers that
    // by clearing its status line — wiping the "Discarded" / "Logged Session
    // A" confirmation the user had not read yet, which is the exact failure
    // the view's comment there was written to prevent.
    abandon() {
      release()
    },

    completed() {
      release()
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
      // Keyed on the ROW, not its index: two rows of one lift are already
      // distinct here (that is what `occurrence` is), and an index changes
      // when a plan edit reorders the session — which let a switched-in lift
      // adopt whatever create its neighbour had in flight.
      //
      // `exercise.blockId` rides along because the entry a row is ATTACHED to
      // is the authority for its writes. Re-deriving instead is right only
      // when the row has no entry: a row matched to an entry whose id doesn't
      // re-derive — one logged before the plan was readable, so keyed on the
      // lift's name — would otherwise get a second, plan-keyed entry beside
      // the one it is displaying, and the session shows the lift twice.
      const {value, stale} = await createExerciseOnce(rowKey(exercise), exercise, workoutId, effects)
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
