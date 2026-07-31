/** Where does this set get written, and what has to be created first? The
 *  answer depends on in-flight state: the workout may not exist yet, may be
 *  mid-create from a tap moments ago (the caller may still hold the
 *  block-less snapshot it started from — "accept all" hands every set the
 *  same one), the exercise may have been switched in mid-session with no
 *  blocks of its own, or the session may have changed mid-create, leaving
 *  the returned ids belonging to a workout this draft no longer edits.
 *
 *  This module owns that decision and de-duplicates in-flight creates. It
 *  performs no writes itself — effects are passed in, so it runs in plain
 *  node against fakes — and the view applies the returned id patches. */

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
  /** The workout this block belongs to, as of when it was resolved — not
   *  read back off the coordinator afterwards, since a create for the
   *  session you just left is deliberately allowed to finish, and reading
   *  "which workout are we on now" would wrongly reject a good set. */
  workoutId?: string
  /** The ENTRY this set's block hangs under, likewise as of resolution: a
   *  set resolved out of the create cache carries no id patch, so callers
   *  can't rebuild it, and `writeSet` needs it to run its parent/status
   *  checks. */
  entryId?: string
  patch?: IdPatch
}

/** The writes this coordinator orchestrates but never performs. */
export interface WriteEffects {
  createWorkout(draft: readonly DraftExercise[]): Promise<MaterializedWorkout>
  createExercise(workoutId: string, exercise: DraftExercise): Promise<ExerciseEntryIds>
}

/** What `reset` actually did — the view needs to tell different reseeds
 *  apart without keeping its own second copy of this module's state. */
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
  /** Which generation is current — a long operation (Finish) captures this
   *  up front and bails if it moved. */
  generation(): number
  /** The view reseeded. Two identifiers, since only one means "a different
   *  workout": `slot` (day + session) may drop the workout id, but never
   *  when there's no live workout yet, or it would forget one just created.
   *  `shape` (which exercises) invalidates `materialized`'s positional ids
   *  and starts a new generation without changing the workout. Idempotent;
   *  reports what changed so the view reacts to the transition. */
  reset(workoutId: string | null, slot: string, shape: string, loaded?: boolean): ResetOutcome
  /** The workout was discarded: creates already in flight stop yielding a
   *  block to write to, since those blocks are about to be tombstoned.
   *  Distinct from `reset`, where writing into the session just left is
   *  still right. */
  abandon(): void
  /** The workout was FINISHED. Same clearing as `abandon`, but a separate
   *  verb because what comes next differs (discard leaves the evening
   *  empty; finish starts the next session in a new slot) — and because a
   *  same-slot `reset(null, …)` deliberately never falls back to null, so
   *  without this the coordinator would keep resolving taps against the
   *  completed session. */
  completed(finishedWorkoutId: string): void
  /** This set block is gone — a write to it came back `gone`. Cached ids
   *  can outlive the block they name, so without this a retry would keep
   *  getting handed the same tombstone. */
  forget(setBlockId: string): void
  /** Take a released workout back — a discard whose delete failed. The
   *  blocks are still there, and release only retires on an authoritative
   *  ABSENCE. */
  restore(workoutId: string): void
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
  /** Per SLOT, the generation at which its workout was released — not a
   *  single global cutoff, or finishing session B while a tap on A was
   *  mid-create would cancel A's too, silently losing it (`persist` reads
   *  no-block as nothing-to-do). Keyed by slot, an `or`-group switch still
   *  bumps the generation within one workout. */
  const releasedThrough = new Map<string, number>()
  /** Workouts this coordinator has let go of. Finish and Discard invalidate
   *  the workout/entry/set queries INDEPENDENTLY, so `live` can rebuild from
   *  a stale `in-progress` row — adopting that id again would resurrect a
   *  session we're done with. Keyed by the SLOT each was released from:
   *  retiring the whole set on any absence would let an empty session B
   *  vouch for session A on a flip-back before A's query publishes. */
  const released = new Map<string, string>()
  /** Set blocks a write has told us are gone. Kept out of `materialized`'s
   *  shortcut so a retry re-derives instead of naming the tombstone again. */
  const deadSets = new Set<string>()
  /** What the most recent release replaced, so it can be put back. A release
   *  cancels the pending work for its slot, and that has to be undoable: the
   *  delete it was made for can fail. */
  let lastRelease: {id: string; slot: string; previousCutoff: number | undefined} | null = null
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

  /** Has the workout a pending resolve was working towards been released
   *  since it started? */
  const cancelled = (atSlot: string, at: number): boolean => (releasedThrough.get(atSlot) ?? -1) >= at

  /** This workout is no longer the one being logged into (discarded or
   *  finished) — creates still in flight stop yielding a block to write to. */
  const release = () => {
    if (workoutId !== null) {
      released.set(workoutId, slot)
      lastRelease = {id: workoutId, slot, previousCutoff: releasedThrough.get(slot)}
    }
    releasedThrough.set(slot, generation)
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
      // An id stays released only until the queries CONFIRM it's gone —
      // after that, reappearance is a genuine restore (undoing a discard),
      // and refusing it forever would leave Discard a no-op.
      if (loaded && nextWorkoutId === null) {
        for (const [id, releasedFrom] of released) {
          if (releasedFrom === nextSlot) released.delete(id)
        }
      }

      // An id we have RELEASED is not a live id, whatever a lagging query
      // says (Finish/Discard invalidate queries independently). Released
      // FROM THIS SLOT specifically — an edited date/session turns up under
      // another slot, which is a relocation, not a workout we're done with.
      const offered = nextWorkoutId !== null && released.get(nextWorkoutId) === nextSlot
        ? null
        : nextWorkoutId

      // A DIFFERENT workout on this slot retires whatever we released from
      // it — otherwise a workout replaced with no empty result in between
      // would stay blacklisted forever, refusing to own blocks it should.
      if (offered !== null) {
        for (const [id, from] of released) {
          if (from === nextSlot && id !== offered) released.delete(id)
        }
      }

      if (nextSlot !== slot) {
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
      const replaced = offered !== null && workoutId !== null && offered !== workoutId
      workoutId = offered ?? workoutId
      if (replaced) {
        // A DIFFERENT workout on the same evening — a peer finished ours and
        // started the next one. Everything cached here is positional inside
        // the old one, so an id from it now names a block in a record.
        generation += 1
        const shapeChanged = nextShape !== shape
        // …including the shape it arrived with, or the NEXT emission would
        // read the same shape as changed again and bump the generation a
        // second time, aborting whatever was mid-flight.
        shape = nextShape
        materialized = null
        creatingWorkout = null
        creatingExercises = new Map()
        return {slotChanged: false, shapeChanged}
      }
      if (nextShape === shape) return {slotChanged: false, shapeChanged: false}

      // The exercise list changed under us: `materialized` is positional, so
      // an in-flight create's ids would land on the wrong rows. New
      // generation; the workout itself keeps being written to.
      generation += 1
      shape = nextShape
      materialized = null
      creatingWorkout = null
      creatingExercises = new Map()
      return {slotChanged: false, shapeChanged: true}
    },

    // `slot` is deliberately untouched by both of these: clearing it would
    // make the next same-slot `reset` report `slotChanged`, and the view
    // answers that by wiping the "Discarded" / "Logged Session A"
    // confirmation the user hasn't read yet.
    abandon() {
      release()
    },

    completed(finishedWorkoutId) {
      if (workoutId === finishedWorkoutId) {
        release()
        return
      }
      // The workout moved while `finishWorkout` was in the air — a peer
      // replaced it, and the effect adopted the replacement. Only the one
      // that was FINISHED is let go: releasing whatever's attached would
      // detach a LIVE session on a finished one's behalf.
      released.set(finishedWorkoutId, slot)
    },

    forget(setBlockId) {
      deadSets.add(setBlockId)
      // The cached create is a RESOLVED promise holding the same ids, so a
      // retry would be handed the dead one straight back out of it. Dropping
      // the cache costs one extra create — idempotent, and rare.
      creatingExercises = new Map()
    },

    restore(id) {
      released.delete(id)
      // …but only over an empty seat: a discard whose delete failed can
      // resolve after the live query adopted the NEXT workout for this slot,
      // and putting the old one back over it would detach a live session.
      // Un-blacklisted either way, so it can be adopted again if it turns up.
      if (workoutId !== null) return
      workoutId = id
      // …and un-cancel what the release cancelled, or a create still in
      // flight would resolve to no block — which `persist` reads as
      // nothing-to-do, silently losing the tap that started it.
      if (lastRelease?.id === id) {
        if (lastRelease.previousCutoff === undefined) releasedThrough.delete(lastRelease.slot)
        else releasedThrough.set(lastRelease.slot, lastRelease.previousCutoff)
        lastRelease = null
      }
    },

    async resolveSet(draft, exIdx, setIdx, effects) {
      const exercise = draft[exIdx]
      if (!exercise) return {}
      const set = exercise.sets[setIdx]
      if (!set) return {}

      // Already has a block — the common case after the first edit — unless
      // a write already told us it's gone, unless the workout is actually
      // detached (the overlay renders `live` directly, so a released
      // workout's ids can linger on screen for a beat, and `writeSet` needs
      // a workout to check its in-progress status against), or unless the
      // row's entry moved out from under it (a set id with no entry means
      // `writeSet` skips its parent/status checks entirely). Falling
      // through re-materializes, which repairs all three.
      if (set.blockId && !deadSets.has(set.blockId) && workoutId !== null && exercise.blockId !== undefined) {
        return {blockId: set.blockId, workoutId, entryId: exercise.blockId}
      }

      if (!workoutId) {
        const at = generation
        const atSlot = slot
        const {value, stale} = await createWorkoutOnce(draft, effects)
        if (!stale) {
          workoutId = value.workoutId
          materialized = value
        }
        if (cancelled(atSlot, at)) return {}
        return {
          blockId: value.exercises[exIdx]?.setIds[setIdx],
          workoutId: value.workoutId,
          ...(value.exercises[exIdx]?.id !== undefined ? {entryId: value.exercises[exIdx].id} : {}),
          ...(stale ? {} : {patch: {kind: 'workout' as const, workout: value}}),
        }
      }

      // Created moments ago in this same batch: the caller's snapshot predates
      // those ids, so consult them before concluding anything is missing —
      // otherwise "accept all" creates the exercise a second time.
      const fromCreate = materialized?.exercises[exIdx]?.setIds[setIdx]
      if (fromCreate && !deadSets.has(fromCreate)) {
        return {blockId: fromCreate, workoutId, entryId: materialized?.exercises[exIdx]?.id}
      }

      // The workout exists but this exercise has no blocks: switched in
      // mid-session.
      const at = generation
      const atSlot = slot
      const forWorkoutId = workoutId
      // Keyed on the ROW, not its index, since a plan edit reordering the
      // session would let a switched-in lift adopt its neighbour's
      // in-flight create. `exercise.blockId` rides along because the entry
      // a row is ATTACHED to is the authority for its writes — re-deriving
      // would give a name-keyed row (logged before the plan was readable) a
      // second, duplicate entry.
      const {value, stale} = await createExerciseOnce(rowKey(exercise), exercise, forWorkoutId, effects)
      // Discarded while this was in flight: the blocks it just made are
      // children of a workout being deleted, so writing into them would
      // strand live todo sets under a tombstone.
      if (cancelled(atSlot, at)) return {}
      return {
        blockId: value.setIds[setIdx],
        workoutId: forWorkoutId,
        entryId: value.id,
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
