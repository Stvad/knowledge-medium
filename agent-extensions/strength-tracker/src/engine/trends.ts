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

/** Per-session working-weight series for one exercise, oldest first. One
 *  point per workout the exercise appears in with a usable working weight. */
export const exerciseSeries = (
  history: readonly WorkoutRecord[],
  exercise: string,
  rolloverHour: number,
): SeriesPoint[] => {
  const points: SeriesPoint[] = []
  for (const workout of history) {
    const entry = workout.exercises.find(e => e.exercise === exercise)
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
  left?: number
  right?: number
  /** True when the logged left side trails the right — the plan's rule is
   *  left leads and right matches, so right-ahead is the flag. */
  rightAhead: boolean
}

const sideModal = (
  history: readonly WorkoutRecord[],
  exercise: string,
  side: 'L' | 'R',
): number | undefined => {
  const last = lastEntryFor(history, exercise)
  if (!last) return undefined
  return modalWeight(last.entry.sets.filter(s => s.side === side))
}

/** Latest left/right comparison for every single-arm lift that has sided
 *  sets logged. */
export const asymmetries = (
  history: readonly WorkoutRecord[],
  config: ProgramConfig,
): Asymmetry[] => {
  const singleArm = config.exercises.filter(e => e.perSide).map(e => e.name)
  const seen = new Set<string>()
  const out: Asymmetry[] = []
  for (const exercise of singleArm) {
    if (seen.has(exercise)) continue
    seen.add(exercise)
    const left = sideModal(history, exercise, 'L')
    const right = sideModal(history, exercise, 'R')
    if (left === undefined && right === undefined) continue
    out.push({
      exercise,
      left,
      right,
      rightAhead: left !== undefined && right !== undefined && right > left,
    })
  }
  return out
}
