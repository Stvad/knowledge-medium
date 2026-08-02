/** Prescription → the blocks a session is stamped from.
 *
 *  Pure: no `@/` import, no clock, no repo. One tap turns this into real
 *  blocks, and from that moment the outline is the only state — so the
 *  expansion happens HERE, once, rather than being re-derived per render and
 *  reconciled against what the blocks say.
 */

import type {PrescribedExercise, Prescription, SessionType} from '../engine/types'

export interface PlannedSet {
  /** What to load. 0 when there's no history to derive one from — the block
   *  is created anyway and you type the number in, which is the same gesture
   *  as correcting a suggestion you disagree with. */
  weight: number
  reps: number
  side?: 'L' | 'R'
  /** Copied down from the prescription so the set row can decide, from the
   *  set alone, whether to ask for an RPE — the same denormalisation as
   *  `unit`, and for the same reason: this is the most-rendered row in the
   *  app and it should not have to load its parent to draw itself. */
  catchUpRpe?: number
}

export interface PlannedLift {
  exercise: string
  /** Plan block this lift was prescribed from, written as a ref so the
   *  definition's backlinks are the lift's logged history. */
  definitionId?: string
  /** Which time in ITS session this lift is. Counted here, once, and stamped
   *  on the entry — sibling position is not identity, and a session may
   *  prescribe one lift twice. */
  occurrence: number
  unit: string
  prescribedWeight?: number
  prescribedSets: number
  /** The rep target as prescribed. Stamped on the entry rather than read
   *  back off a set block, which is a number the user edits — logging 8 reps
   *  on set one turned "target 3×10" into "target 3×8". */
  prescribedReps?: number
  sets: readonly PlannedSet[]
}

export interface SessionPlan {
  day: string
  session: SessionType
  lifts: readonly PlannedLift[]
}

/** One row per set — two per prescribed set for single-arm work, left then
 *  right, which is the order the plan's "left leads and right matches" rule
 *  wants them performed in. */
const setsFor = (exercise: PrescribedExercise): PlannedSet[] => {
  // Carries and rounds-based work have no rep range at all, so the range is
  // no help — but what you did last time is. Stamping 0 there records a set
  // performed for zero reps, which is a real number the engine and every
  // volume total then believe.
  const reps = exercise.repMax ?? exercise.repMin
    ?? exercise.lastTime?.reps.find(count => count > 0) ?? 0
  const weight = exercise.weight ?? 0
  const asks = exercise.catchUpRpe !== undefined ? {catchUpRpe: exercise.catchUpRpe} : {}
  const rows: PlannedSet[] = []
  for (let i = 0; i < Math.max(0, exercise.sets); i += 1) {
    // The RPE prompt goes on the LEFT row only. `progressionSets` drops
    // `side: 'R'` rows and `allSetsAtOrBelowRpe` reads through it, so a rating
    // on the right is never read by anything — asking for it breaks the rule
    // the control exists under (it appears only where it can change a future
    // prescription) and costs a tap per set on the narrowest screen there is.
    if (exercise.perSide) rows.push({weight, reps, side: 'L', ...asks}, {weight, reps, side: 'R'})
    else rows.push({weight, reps, ...asks})
  }
  return rows
}

/** Occurrence is counted over the prescription's own list, keyed the way
 *  `prescribe` keys it — the plan block when there is one, else the name.
 *  Two lists counted separately is how a row used to end up writing into its
 *  neighbour's blocks; there is only this one now. */
export const planFromPrescription = (
  prescription: Prescription,
  unit: string,
): SessionPlan => {
  const seen = new Map<string, number>()
  const lifts = prescription.exercises.map((exercise): PlannedLift => {
    const key = exercise.defId ?? exercise.exercise
    const occurrence = seen.get(key) ?? 0
    seen.set(key, occurrence + 1)
    // Taken from the expanded rows rather than recomputed from the rep range:
    // `setsFor` already resolved the fallbacks a carry needs, and two places
    // deriving "what reps did we ask for" is two places to disagree.
    const sets = setsFor(exercise)
    return {
      exercise: exercise.exercise,
      ...(exercise.defId !== undefined ? {definitionId: exercise.defId} : {}),
      occurrence,
      unit,
      ...(exercise.weight !== undefined ? {prescribedWeight: exercise.weight} : {}),
      prescribedSets: exercise.sets,
      ...(sets[0] !== undefined ? {prescribedReps: sets[0].reps} : {}),
      sets,
    }
  })
  return {day: prescription.day, session: prescription.session, lifts}
}

/** Which of the dialog's picks the confirmed prescription actually stands
 *  behind.
 *
 *  The start dialog lets you flip an `or`-group and THEN change session, so
 *  `choices` can carry a group belonging to a session you did not start.
 *  Recording it would quietly retrack a future session you never opened —
 *  and, with no exercise in this prescription to take a name from, the
 *  writer's label fell through to the option's raw block id, which is what
 *  then appears as the choice's name in the settings outline.
 *
 *  Structurally narrow rather than a check at the call site: the label and
 *  the decision to record come from the same lookup, so there is no shape in
 *  which one is found and the other guessed. */
export const choicesToRecord = (
  choices: Readonly<Record<string, string>>,
  exercises: readonly {exercise: string; altGroupKey?: string}[],
): {groupKey: string; optionKey: string; label: string}[] =>
  Object.entries(choices).flatMap(([groupKey, optionKey]) => {
    const option = exercises.find(exercise => exercise.altGroupKey === groupKey)
    return option === undefined ? [] : [{groupKey, optionKey, label: option.exercise}]
  })

// There used to be a matcher here — two passes deciding which existing entry
// each row of a plan continues, so a second Start tap adopted the first tap's
// entries instead of deriving a second set of them. `startSession` no longer
// writes into a session that already exists (it hands the standing one back
// untouched), so nothing has an entry to match against a plan row. Deleted
// rather than kept for a caller that might want it: the whole class of bug it
// guarded — one entry serving two lifts, a lift forked across two set trees —
// exists only on a write path there no longer is.
