/** What "Finish" does to the workout tree — the decision half.
 *
 *  Pure, and taken over the COMMITTED tree read inside the finishing
 *  transaction. That is the whole point of the module: every way this has
 *  lost a logged set came from deciding against something older than the
 *  blocks. See `finishPlan`.
 */

import {workingWeight} from '../engine/progression'

/** Exactly what the decision reads off one logged lift — no more.
 *
 *  Narrower than `LiveExercise` on purpose: taking the whole thing meant the
 *  one caller had to invent a `unit`, a `day` and a `session` it does not know
 *  in order to satisfy the type, and the invented `session` was wrong every
 *  time a B or mini day was finished. Nothing read them, so nothing broke —
 *  which is the problem with fabricating data to satisfy a type. A
 *  `LiveExercise` still satisfies this structurally. */
export interface FinishEntry {
  id: string
  exercise: string
  sets: readonly {
    id: string
    weight: number
    reps: number
    side?: 'L' | 'R'
    done: boolean
  }[]
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

/** What "Finish" keeps vs prunes, decided ENTIRELY from the committed tree.
 *
 *  An exercise with at least one accepted set keeps only those sets (with the
 *  derived working weight); one with none is removed wholesale.
 *
 *  The input is deliberately the workout as the BLOCKS state it, read inside
 *  the finishing transaction — not the draft, and not a query snapshot. Every
 *  way this has lost data came from planning against something older than the
 *  blocks:
 *
 *   - done-ness is the built-in todo checkbox, so it can be set from the
 *     outline below this view, from a todo list, from another device, at any
 *     moment including during Finish's own writes;
 *   - an entry can hold set blocks the draft never saw — it was ADOPTED
 *     rather than created, or a peer appended one — and planning only the
 *     draft's sets left those live as open todos under a finished workout;
 *   - an entry the draft has no row for at all (the `or`-group option you
 *     switched away from) is real logged work and gets exactly the same rule.
 *
 *  Reading the committed tree makes all three the same case. The draft's job
 *  is to have written its ticks BEFORE this runs, which is what `finish` does.
 */
export const finishPlan = (workoutId: string, entries: readonly FinishEntry[]): FinishPlan => {
  const keep: FinishPlan['keep'] = []
  const removeExerciseIds: string[] = []

  for (const entry of entries) {
    const accepted = entry.sets.filter(s => s.done)
    if (accepted.length === 0) {
      removeExerciseIds.push(entry.id)
      continue
    }
    keep.push({
      exerciseId: entry.id,
      workingWeight: workingWeight({
        exercise: entry.exercise,
        sets: accepted.map(s => ({weight: s.weight, reps: s.reps, side: s.side})),
      }),
      removeSetIds: entry.sets.filter(s => !s.done).map(s => s.id),
    })
  }
  return {workoutId, keep, removeExerciseIds}
}
