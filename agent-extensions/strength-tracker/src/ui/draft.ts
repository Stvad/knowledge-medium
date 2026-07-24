/** Logging draft — the local, unsaved state of tonight's session.
 *
 *  Pure and UI-independent: build an initial draft from a prescription
 *  (every set pre-filled so accepting as-prescribed is a single tap), and
 *  fold the accepted sets back into the `WorkoutDraft` the store writes.
 */

import type {Prescription, PrescribedExercise} from '../engine/types'
import type {StoredSet} from '../km/fields'
import type {WorkoutDraft} from '../km/store'

export interface DraftSet {
  weight: number
  reps: number
  /** Accepted — only accepted sets are written. Pre-filled sets start
   *  un-accepted so an untouched exercise records nothing. */
  done: boolean
  rpe?: number
  side?: 'L' | 'R'
}

export interface DraftExercise {
  exercise: string
  unit: string
  freeform: boolean
  perSide: boolean
  repMin?: number
  repMax?: number
  prescribedWeight?: number
  prescribedSets?: number
  rationale: string
  note?: string
  sets: DraftSet[]
}

/** Reps to pre-fill a set with: aim for the top of the range (that's what
 *  earns the next jump); fall back to last time's reps for freeform work,
 *  else the bottom of the range, else blank-ish. */
const defaultReps = (ex: PrescribedExercise): number => {
  if (ex.repMax !== undefined) return ex.repMax
  const lastReps = ex.lastTime?.reps
  if (lastReps && lastReps.length > 0) return lastReps[0]
  return ex.repMin ?? 0
}

const initialSets = (ex: PrescribedExercise): DraftSet[] => {
  const weight = ex.weight ?? 0
  const reps = defaultReps(ex)
  const n = Math.max(1, ex.sets)
  if (ex.perSide) {
    return Array.from({length: n}, (_, i) => i).flatMap(() => [
      {weight, reps, done: false, side: 'L' as const},
      {weight, reps, done: false, side: 'R' as const},
    ])
  }
  return Array.from({length: n}, () => ({weight, reps, done: false}))
}

export const buildDraft = (prescription: Prescription, unit: string): DraftExercise[] =>
  prescription.exercises.map(ex => ({
    exercise: ex.exercise,
    unit,
    freeform: ex.freeform,
    perSide: ex.perSide,
    repMin: ex.repMin,
    repMax: ex.repMax,
    prescribedWeight: ex.weight,
    prescribedSets: ex.sets,
    rationale: ex.rationale,
    note: ex.note,
    sets: initialSets(ex),
  }))

const toStoredSet = (set: DraftSet): StoredSet => ({
  weight: set.weight,
  reps: set.reps,
  ...(set.rpe !== undefined ? {rpe: set.rpe} : {}),
  ...(set.side !== undefined ? {side: set.side} : {}),
})

/** True when at least one set anywhere has been accepted — gates the
 *  "Finish" button. */
export const hasAcceptedSets = (draft: readonly DraftExercise[]): boolean =>
  draft.some(ex => ex.sets.some(s => s.done))

/** Collapse the draft into what the store writes: only exercises with
 *  accepted sets, only the accepted sets. */
export const toWorkoutDraft = (
  day: string,
  session: Prescription['session'],
  draft: readonly DraftExercise[],
): WorkoutDraft => ({
  day,
  session,
  exercises: draft
    .map(ex => ({
      exercise: ex.exercise,
      unit: ex.unit,
      prescribedWeight: ex.prescribedWeight,
      prescribedSets: ex.prescribedSets,
      sets: ex.sets.filter(s => s.done).map(toStoredSet),
    }))
    .filter(ex => ex.sets.length > 0),
})
