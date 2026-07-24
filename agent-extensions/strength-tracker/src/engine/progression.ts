/** Double progression.
 *
 *  The plan's rule, verbatim: "Each main lift lives in a rep range (6–10).
 *  Same weight until top of range on ALL sets → add 5 lb (upper) / 10 lb
 *  (lower) next session."
 *
 *  Two details the rule leaves implicit and this module decides:
 *
 *  - *Which* weight is "the" weight for a session, given sets can drift
 *    (a drop set, a mis-loaded bar). We take the modal weight across the
 *    entry's sets, breaking ties heavy. That matches how the sets were
 *    actually prescribed — one working weight, N sets.
 *  - "ALL sets" means all *prescribed* sets. The count comes from what was
 *    prescribed at the time (recorded on the entry), not from today's
 *    config, so cutting a set for soreness doesn't retroactively make a
 *    2-set night count as a completed 3-set night once config changes.
 */

import type {ExerciseConfig, ExerciseRecord, SetRecord, WorkoutRecord} from './types'

/** Sets that count toward progression: the side-agnostic ones, plus — for
 *  single-arm work — the left side only. The plan's asymmetry rule is
 *  "left sets the reps, right matches", so the left side is the honest
 *  progression signal. */
export const progressionSets = (sets: readonly SetRecord[]): readonly SetRecord[] => {
  const sided = sets.filter(s => s.side !== undefined)
  if (sided.length === 0) return sets
  return sets.filter(s => s.side !== 'R')
}

/** Modal weight across a set list, ties broken heavy. Undefined for an
 *  empty list. Side-agnostic — pass exactly the sets you mean (e.g. one
 *  side's sets for an asymmetry read). */
export const modalWeight = (sets: readonly SetRecord[]): number | undefined => {
  if (sets.length === 0) return undefined
  const counts = new Map<number, number>()
  for (const set of sets) counts.set(set.weight, (counts.get(set.weight) ?? 0) + 1)
  let best: number | undefined
  let bestCount = 0
  for (const [weight, count] of counts) {
    if (count > bestCount || (count === bestCount && weight > (best ?? -Infinity))) {
      best = weight
      bestCount = count
    }
  }
  return best
}

/** Working weight for progression judgement: the modal weight across the
 *  sets that count toward progression (left side only for single-arm work).
 *  Undefined for an entry with no such sets. */
export const workingWeight = (entry: ExerciseRecord): number | undefined =>
  modalWeight(progressionSets(entry.sets))

/** Most recent logged entry for an exercise, or undefined. `history` may
 *  arrive in any order; the caller's day ordering is not assumed. */
export const lastEntryFor = (
  history: readonly WorkoutRecord[],
  exercise: string,
): {workout: WorkoutRecord; entry: ExerciseRecord} | undefined => {
  let best: {workout: WorkoutRecord; entry: ExerciseRecord} | undefined
  for (const workout of history) {
    const entry = workout.exercises.find(e => e.exercise === exercise)
    if (!entry || entry.sets.length === 0) continue
    if (!best || workout.date > best.workout.date) best = {workout, entry}
  }
  return best
}

/** True when every prescribed set hit the top of the range at the working
 *  weight. Freeform work (no rep range) never tops out — it isn't
 *  load-progressed at all. */
export const toppedOut = (
  entry: ExerciseRecord,
  config: Pick<ExerciseConfig, 'sets' | 'repMax' | 'freeform'>,
): boolean => {
  if (config.freeform || config.repMax === undefined) return false
  const weight = workingWeight(entry)
  if (weight === undefined) return false
  const target = entry.prescribedSets ?? config.sets
  const atWeight = progressionSets(entry.sets).filter(s => s.weight === weight)
  if (atWeight.length < target) return false
  return atWeight.every(s => s.reps >= config.repMax!)
}

export interface ProgressionStep {
  weight: number
  /** True when the weight went up this session. */
  progressed: boolean
}

/** Next weight for an exercise given its last logged entry. `hold`
 *  suppresses the jump — the "missed 1 session → repeat last weights" row. */
export const nextWeight = (
  entry: ExerciseRecord,
  config: Pick<ExerciseConfig, 'sets' | 'repMax' | 'freeform' | 'increment'>,
  opts: {hold?: boolean} = {},
): ProgressionStep | undefined => {
  const weight = workingWeight(entry)
  if (weight === undefined) return undefined
  if (opts.hold) return {weight, progressed: false}
  if (!toppedOut(entry, config)) return {weight, progressed: false}
  return {weight: weight + config.increment, progressed: true}
}

/** Round a percentage-derived load onto loadable plates. Rounds down: at
 *  1am, coming back from a break, the error should be on the light side. */
export const roundLoad = (weight: number, roundTo: number): number => {
  if (roundTo <= 0) return weight
  return Math.floor(weight / roundTo) * roundTo
}
