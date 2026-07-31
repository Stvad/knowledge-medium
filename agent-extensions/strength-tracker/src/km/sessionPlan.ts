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
}

export interface PlannedLift {
  exercise: string
  /** Plan block this lift was prescribed from, written as a ref so the
   *  definition's backlinks are the lift's logged history. */
  definitionId?: string
  /** Which time in ITS session this lift is. Counted here, once, and the
   *  same number the entry's block id derives from — sibling position is not
   *  identity, and a session may prescribe one lift twice. */
  occurrence: number
  unit: string
  prescribedWeight?: number
  prescribedSets: number
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
  const reps = exercise.repMax ?? exercise.repMin ?? 0
  const weight = exercise.weight ?? 0
  const rows: PlannedSet[] = []
  for (let i = 0; i < Math.max(0, exercise.sets); i += 1) {
    if (exercise.perSide) rows.push({weight, reps, side: 'L'}, {weight, reps, side: 'R'})
    else rows.push({weight, reps})
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
    return {
      exercise: exercise.exercise,
      ...(exercise.defId !== undefined ? {definitionId: exercise.defId} : {}),
      occurrence,
      unit,
      ...(exercise.weight !== undefined ? {prescribedWeight: exercise.weight} : {}),
      prescribedSets: exercise.sets,
      sets: setsFor(exercise),
    }
  })
  return {day: prescription.day, session: prescription.session, lifts}
}
