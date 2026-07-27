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
  /** The workout this block belongs to, as of when it was resolved.
   *
   *  Returned rather than read back off the coordinator afterwards, because
   *  by then it can be a DIFFERENT workout: a create for the session you just
   *  left is deliberately allowed to finish, and asking "which workout are we
   *  on now" gives the one you switched TO. Validating the write against that
   *  rejects a perfectly good set from the session it belongs to. */
  workoutId?: string
  /** The ENTRY this set's block hangs under, likewise as of resolution.
   *
   *  Returned for the same reason as the workout, and because callers cannot
   *  reliably rebuild it: a set resolved out of the create cache comes back
   *  with no id patch, so the draft row it belongs to still carries no entry
   *  id — and `writeSet` skips its parent AND workout-status checks entirely
   *  when it is handed no parent, which is how a write reached a set in an
   *  already-finished session. */
  entryId?: string
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
  completed(finishedWorkoutId: string): void
  /** This set block is gone — a write to it came back `gone`. The cached ids
   *  from our own create outlive the block they name, so the shortcut below
   *  kept handing the same tombstone back: every retry answered `gone`, the
   *  resync cleared the row again, and the set could not be recreated until a
   *  session or shape change reset the cache. */
  forget(setBlockId: string): void
  /** Take a released workout back, because letting go of it turned out to be
   *  wrong — a discard whose delete failed. The blocks are still there, and
   *  nothing else will hand them back: a release retires on an authoritative
   *  ABSENCE, and this workout is present. */
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
  /** Per SLOT, the generation at which its workout was released.
   *
   *  A pending resolve is cancelled only if the blocks it is about to produce
   *  belong to a released workout — which means its slot AND its generation,
   *  not "everything older". A single global cutoff cancelled work belonging
   *  to a different session entirely: a tap on A whose create was still in
   *  flight, while the user switched to B and finished B, resolved to no
   *  block at all — and `persist` reads no-block as nothing-to-do, so the tap
   *  was lost without an error. Keyed by slot it stays precise in the
   *  direction that matters too: an `or`-group switch bumps the generation
   *  within one workout, and a discard must still cancel the create that
   *  started before it. */
  const releasedThrough = new Map<string, number>()
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

  /** This workout is no longer the one being logged into — it was discarded
   *  or finished. Results from creates still in flight stop yielding a block
   *  to write to: those blocks now belong to a tombstone or to a completed
   *  record, and either way a write into them is wrong. */
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
      // Released FROM THIS SLOT, specifically. A workout whose date or session
      // was edited leaves the slot we were watching and turns up under
      // another — that is a relocation, not a workout we are done with, and
      // refusing it there left the blocks on screen with no workout id behind
      // them: Finish said the session had changed and Discard did nothing.
      const offered = nextWorkoutId !== null && released.get(nextWorkoutId) === nextSlot
        ? null
        : nextWorkoutId

      // A DIFFERENT workout on this slot retires whatever we released from it.
      // Retiring only on an authoritative absence missed the case where one
      // workout is replaced by the next with no empty result in between — the
      // old id stayed blacklisted forever, so undoing its finish or its
      // deletion put the blocks back on screen with the coordinator refusing
      // to own them.
      if (offered !== null) {
        for (const [id, from] of released) {
          if (from === nextSlot && id !== offered) released.delete(id)
        }
      }

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
      const replaced = offered !== null && workoutId !== null && offered !== workoutId
      workoutId = offered ?? workoutId
      if (replaced) {
        // A DIFFERENT workout on the same evening — a peer finished ours and
        // started the next one, and our query jumped straight from one to the
        // other. Everything cached here is positional inside the old one, and
        // an id taken from it names a block in a workout that is now a record.
        generation += 1
        const shapeChanged = nextShape !== shape
        // …including the shape it arrived with. Leaving it behind made the
        // NEXT emission read the same shape as changed again, bump the
        // generation a second time, and abort whatever was mid-flight — an
        // accept-all batch between sets, or a Finish that then reported the
        // session had changed.
        shape = nextShape
        materialized = null
        creatingWorkout = null
        creatingExercises = new Map()
        return {slotChanged: false, shapeChanged}
      }
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

    completed(finishedWorkoutId) {
      if (workoutId === finishedWorkoutId) {
        release()
        return
      }
      // The workout moved while `finishWorkout` was in the air — a peer
      // replaced it, and the effect adopted the replacement. Only the one
      // that was FINISHED is let go: releasing whatever happened to be
      // attached detached a LIVE session on a finished one's behalf, so its
      // Discard and Finish stopped working and the next tap opened a third
      // workout for the evening.
      released.set(finishedWorkoutId, slot)
    },

    forget(setBlockId) {
      deadSets.add(setBlockId)
      // The cached create is a RESOLVED promise holding the same ids, so a
      // retry would be handed the dead one straight back out of it without
      // ever consulting the list above. Dropping the cache costs one extra
      // create — idempotent, and only on the rare path where a write came
      // back `gone`.
      creatingExercises = new Map()
    },

    restore(id) {
      released.delete(id)
      workoutId = id
      // …and un-cancel what the release cancelled. Handing the workout back
      // without this left a create still in flight resolving to no block at
      // all — which `persist` reads as nothing-to-do, so the set edit that
      // started it vanished with no error, on a workout that is still there.
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

      // Already has a block: the common case after the first edit — unless a
      // write has told us that block is gone. `persist` stamps the create's
      // ids into the draft before the write runs, so on a `gone` the very id
      // we were told to forget is sitting right here, and returning it sent
      // the retry back to the same tombstone.
      // …and only while a workout is actually attached. Detached, the ids in
      // the draft are whatever a lagging query put back — the overlay reads
      // `live` directly, so a workout this coordinator has released is still
      // rendered for a beat after a finish. Handing the set id back without a
      // workout sent the write out with nothing to validate against, and the
      // in-progress check is the one that refuses a completed record: the tap
      // landed in the finished session. With no workout, the create path is
      // the right answer — it is what starts the evening's second session.
      if (set.blockId && !deadSets.has(set.blockId) && workoutId !== null) {
        return {blockId: set.blockId, workoutId, ...(exercise.blockId !== undefined ? {entryId: exercise.blockId} : {})}
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
      const {value, stale} = await createExerciseOnce(rowKey(exercise), exercise, forWorkoutId, effects)
      // Discarded while this was in flight: the blocks it just made are
      // children of a workout that is being deleted, so writing into them
      // would strand live todo sets under a tombstone.
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
