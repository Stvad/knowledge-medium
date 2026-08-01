/** Prescription → the blocks a session is stamped from.
 *
 *  Pure: no `@/` import, no clock, no repo. One tap turns this into real
 *  blocks, and from that moment the outline is the only state — so the
 *  expansion happens HERE, once, rather than being re-derived per render and
 *  reconciled against what the blocks say.
 */

import type {PrescribedExercise, Prescription, SessionType} from '../engine/types'
import {FIELD} from './fields'

/** The little of a block this decision reads — a structural subset of the
 *  app's `BlockData`, so a real row satisfies it without importing the type.
 *  Keeping the decision pure is what lets it be tested directly rather than
 *  only through whichever database states a caller can be coaxed into. */
export interface EntryRow {
  id: string
  properties: Record<string, unknown>
}

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

export const definitionOf = (block: EntryRow): string | undefined =>
  typeof block.properties[FIELD.definition] === 'string'
    ? block.properties[FIELD.definition] as string
    : undefined

/** Could this entry be this lift's — same slot, same name, and not naming a
 *  DIFFERENT plan block. Permissive about one side lacking one, which is the
 *  point: that is a session started before the plan synced, or after it
 *  stopped resolving. */
export const namesThisLift = (block: EntryRow, lift: PlannedLift): boolean => {
  if ((block.properties[FIELD.occurrence] ?? 0) !== lift.occurrence) return false
  if (block.properties[FIELD.exercise] !== lift.exercise) return false
  const definition = definitionOf(block)
  return definition === undefined || lift.definitionId === undefined
    || definition === lift.definitionId
}

/** …and the plan block agrees exactly, absent-vs-absent included. */
export const isExactlyThisLift = (block: EntryRow, lift: PlannedLift): boolean =>
  namesThisLift(block, lift) && definitionOf(block) === lift.definitionId

/** Which existing entry each row of the plan continues.
 *
 *  TWO passes, and their order is the design. Matching greedily row by row
 *  makes the answer depend on where a row sits: a lift whose plan block could
 *  not be read would claim the plan-keyed entry of a same-named lift listed
 *  after it, and both rows end up on the wrong tree. Every exact match is
 *  settled FIRST, across all rows; only then may a row fall back to an entry
 *  whose plan block is absent on one side.
 *
 *  The fallback is not optional. A device that started the session before the
 *  plan synced keyed its entries on the NAME; the next tap, with the plan
 *  readable, keys on the plan block and derives elsewhere — so without a
 *  by-name second pass it stamps a second entry, and a second whole set tree,
 *  inside the same workout. It happens in both directions, which is why the
 *  fallback is symmetric while the first pass is not. */
export const matchEntries = <T extends EntryRow>(
  lifts: readonly PlannedLift[],
  entries: readonly T[],
): (T | undefined)[] => {
  const matched: (T | undefined)[] = lifts.map(() => undefined)
  const claimed = new Set<string>()
  const pass = (fits: (block: EntryRow, lift: PlannedLift) => boolean): void => {
    lifts.forEach((lift, index) => {
      if (matched[index] !== undefined) return
      const hit = entries.find(block => !claimed.has(block.id) && fits(block, lift))
      if (hit === undefined) return
      matched[index] = hit
      claimed.add(hit.id)
    })
  }
  pass(isExactlyThisLift)
  pass(namesThisLift)
  return matched
}
