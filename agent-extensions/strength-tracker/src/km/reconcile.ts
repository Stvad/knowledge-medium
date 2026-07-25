/** Adopting a workout that is already there.
 *
 *  Starting a session used to mean "create the blocks", full stop. That is
 *  wrong whenever a workout for this day+session already exists and this
 *  client doesn't know it yet — the reactive query returns an empty array
 *  while it loads, so on first paint "still loading" and "nothing logged"
 *  look identical. A checkbox tapped in that window (a reload mid-session, a
 *  PWA restart, a phone unlock) created a SECOND workout, which the query
 *  then hid behind the older one: never rendered, never finishable, and a
 *  full set of open todo sets left in the agenda forever.
 *
 *  So the create is now adopt-or-create, and this module is the decision half
 *  of the adopt: given the workout that exists and the draft being logged,
 *  which entry blocks does each row reuse, and which set blocks are missing.
 *  Pure, so the matching can be exercised without a repo — the effectful half
 *  (`startWorkout` in store.ts) just executes what it returns.
 */

import {matchLiveExercises, type LiveWorkout} from './history'
import type {WorkoutDraft} from './store'

export interface ReconciledEntry {
  /** Entry block this row logs into, when it matched one in the existing
   *  workout. Undefined means the row has no entry there yet and the whole
   *  thing (entry + sets) has to be written. */
  existingId?: string
  /** Set blocks already present, positionally aligned to the draft's sets.
   *  `undefined` at an index means that set still needs a block — the entry
   *  was logged with fewer sets than the draft prescribes (the plan changed,
   *  or the other device was mid-edit). */
  setIds: readonly (string | undefined)[]
}

/** What to reuse from `existing` for each row of `draft`, positionally.
 *
 *  Entries the draft has no row for are simply not mentioned: they are real
 *  logged work (the `or`-group option the other device chose), so adopting
 *  must not touch them. `finishPlan` decides their fate at the end, under the
 *  same keep-if-anything-was-done rule everything else gets. */
export const reconcilePlan = (existing: LiveWorkout, draft: WorkoutDraft): ReconciledEntry[] => {
  const matches = matchLiveExercises(
    draft.exercises.map(ex => ({name: ex.exercise, defId: ex.definitionId})),
    existing,
  )
  return draft.exercises.map((ex, i) => {
    const match = matches[i]
    if (!match) return {setIds: ex.sets.map(() => undefined)}
    return {existingId: match.id, setIds: ex.sets.map((_, j) => match.sets[j]?.id)}
  })
}
