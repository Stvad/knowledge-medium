/** Trends, milestones, and asymmetry — the "look back" half of the UI.
 *
 *  All pure derivations over logged history, so the charts and milestone
 *  bars render from tested functions rather than ad-hoc component logic.
 */

import {lastEntryFor, modalWeight, workingWeight} from './progression'
import {trainingDay} from './schedule'
import type {Milestone, ProgramConfig, WorkoutRecord} from './types'

export interface SeriesPoint {
  day: string
  weight: number
}

/** Which line a trend card is drawing.
 *
 *  Not just the name: a plan can prescribe one lift TWICE at different loads,
 *  which is what `occurrence` exists for everywhere else. Keyed by name alone,
 *  both cards found the first same-named entry in each workout — so they drew
 *  the identical series and the second row's history was nowhere on screen. */
export interface SeriesKey {
  exercise: string
  defId?: string
  /** Which time in the session, counted the way `planFromPrescription` counts
   *  it. Absent means "the first match", which is all a record written before
   *  entries stored the number can answer to. */
  occurrence?: number
}

/** Per-session working-weight series for one line of the plan, oldest first.
 *  One point per workout it appears in with a usable working weight. */
export const exerciseSeries = (
  history: readonly WorkoutRecord[],
  key: SeriesKey,
  rolloverHour: number,
): SeriesPoint[] => {
  const points: SeriesPoint[] = []
  for (const workout of history) {
    // Through the SAME matcher progression uses, so a card and the number it
    // is drawn from cannot disagree about which row they mean.
    const entry = lastEntryFor([workout], key.exercise, key.defId, key.occurrence)?.entry
    if (!entry) continue
    const weight = workingWeight(entry)
    if (weight === undefined) continue
    points.push({day: trainingDay(workout.date, rolloverHour), weight})
  }
  return points.sort((a, b) => a.day.localeCompare(b.day))
}

export interface MilestoneProgress {
  milestone: Milestone
  /** Best working weight logged for the lift, or undefined if never logged. */
  best?: number
  /** best / target, clamped to [0, 1]. */
  fraction: number
  hit: boolean
}

/** Best (heaviest) working weight ever logged for an exercise. */
export const bestWorkingWeight = (
  history: readonly WorkoutRecord[],
  exercise: string,
): number | undefined => {
  let best: number | undefined
  for (const workout of history) {
    const entry = workout.exercises.find(e => e.exercise === exercise)
    if (!entry) continue
    const weight = workingWeight(entry)
    if (weight !== undefined && (best === undefined || weight > best)) best = weight
  }
  return best
}

export const milestoneProgress = (
  history: readonly WorkoutRecord[],
  config: ProgramConfig,
): MilestoneProgress[] =>
  config.milestones.map(milestone => {
    const best = bestWorkingWeight(history, milestone.exercise)
    const fraction = best === undefined ? 0 : Math.max(0, Math.min(1, best / milestone.weight))
    return {milestone, best, fraction, hit: best !== undefined && best >= milestone.weight}
  })

export interface Asymmetry {
  exercise: string
  /** Which of several same-named rows this is — see `SeriesKey`. Carried so
   *  the UI can key and label two rows of one lift apart. */
  occurrence: number
  left?: number
  right?: number
  /** True when the logged left side trails the right — the plan's rule is
   *  left leads and right matches, so right-ahead is the flag. */
  rightAhead: boolean
}

const sideModal = (
  history: readonly WorkoutRecord[],
  key: SeriesKey,
  side: 'L' | 'R',
): number | undefined => {
  const last = lastEntryFor(history, key.exercise, key.defId, key.occurrence)
  if (!last) return undefined
  return modalWeight(last.entry.sets.filter(s => s.side === side))
}

/** Latest left/right comparison for every single-arm lift that has sided
 *  sets logged. */
export const asymmetries = (
  history: readonly WorkoutRecord[],
  config: ProgramConfig,
): Asymmetry[] => {
  // Counted, not deduplicated. Skipping the second same-named row showed
  // occurrence 0 twice over and hid occurrence 1 entirely — the same fault
  // `exerciseSeries` had, in its sibling reader. Occurrence is counted here
  // exactly as `planFromPrescription` and `prescribe` count it, over the same
  // list, so all three agree about which row is which.
  const seen = new Map<string, number>()
  const out: Asymmetry[] = []
  for (const exercise of config.exercises.filter(e => e.perSide)) {
    const identityKey = exercise.defId ?? exercise.name
    const occurrence = seen.get(identityKey) ?? 0
    seen.set(identityKey, occurrence + 1)
    const key: SeriesKey = {
      exercise: exercise.name,
      ...(exercise.defId !== undefined ? {defId: exercise.defId} : {}),
      occurrence,
    }
    const left = sideModal(history, key, 'L')
    const right = sideModal(history, key, 'R')
    if (left === undefined && right === undefined) continue
    out.push({
      exercise: exercise.name,
      occurrence,
      left,
      right,
      rightAhead: left !== undefined && right !== undefined && right > left,
    })
  }
  return out
}
