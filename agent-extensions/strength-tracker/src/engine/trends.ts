/** Trends, milestones, and asymmetry — the "look back" half of the UI.
 *
 *  All pure derivations over logged history, so the charts and milestone
 *  bars render from tested functions rather than ad-hoc component logic.
 */

import {
  judgedSets,
  lastEntryFor,
  sessionsNewestFirst,
  setsAtModalWeight,
  setsAtWorkingWeight,
  stallIn,
  workingWeight,
} from './progression'
import {trainingDay} from './schedule'
import {programOccurrences} from './types'
import type {LiftRatio, Milestone, ProgramConfig, WorkoutRecord} from './types'

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

/** Best (heaviest) working weight ever logged for an exercise, counting only
 *  sessions where a set at that weight reached `minReps` — "115×3" is three
 *  reps at 115, not one. */
export const bestWorkingWeight = (
  history: readonly WorkoutRecord[],
  exercise: string,
  minReps = 0,
): number | undefined => {
  let best: number | undefined
  for (const workout of history) {
    const entry = workout.exercises.find(e => e.exercise === exercise)
    const working = entry ? setsAtWorkingWeight(entry) : undefined
    if (!working || !working.sets.some(s => s.reps >= minReps)) continue
    if (best === undefined || working.weight > best) best = working.weight
  }
  return best
}

export const milestoneProgress = (
  history: readonly WorkoutRecord[],
  config: ProgramConfig,
): MilestoneProgress[] =>
  config.milestones.map(milestone => {
    const best = bestWorkingWeight(history, milestone.exercise, milestone.reps)
    const fraction = best === undefined ? 0 : Math.max(0, Math.min(1, best / milestone.weight))
    return {milestone, best, fraction, hit: best !== undefined && best >= milestone.weight}
  })

export interface Asymmetry {
  exercise: string
  /** Unique to the row — see `programOccurrences`. */
  key: string
  defId?: string
  /** Which of several rows sharing one identity this is — see `SeriesKey`. */
  occurrence: number
  left?: number
  right?: number
  /** Reps at that modal weight, per side. Carried because weight alone cannot
   *  express the most ordinary disparity there is — see `rightAhead`. */
  leftReps?: number
  rightReps?: number
  /** True when the logged left side trails the right — the plan's rule is
   *  left leads and right matches, so right-ahead is the flag.
   *
   *  Weight FIRST, then reps at that weight. Comparing modal weight alone made
   *  the commonest case invisible: single-arm work is usually loaded with the
   *  one dumbbell you have, so both sides sit at the same number and the right
   *  pulls ahead in REPS — `45×8` against `45×10` reported no asymmetry at
   *  all, which is precisely the session the flag exists to catch. */
  rightAhead: boolean
}

interface SidePerformance {
  weight: number
  /** The most reps done at that weight, which is what "the right matched and
   *  then some" looks like in the log. */
  reps: number
}

const sidePerformance = (
  history: readonly WorkoutRecord[],
  key: SeriesKey,
  side: 'L' | 'R',
): SidePerformance | undefined => {
  const last = lastEntryFor(history, key.exercise, key.defId, key.occurrence)
  const atWeight = last ? setsAtModalWeight(last.entry.sets.filter(s => s.side === side)) : undefined
  return atWeight && {weight: atWeight.weight, reps: Math.max(...atWeight.sets.map(s => s.reps))}
}

/** Latest left/right comparison for every single-arm lift that has sided
 *  sets logged. */
export const asymmetries = (
  history: readonly WorkoutRecord[],
  config: ProgramConfig,
): Asymmetry[] => {
  const out: Asymmetry[] = []
  for (const {item: exercise, occurrence, key: rowKey} of programOccurrences(config.exercises)) {
    if (!exercise.perSide) continue
    const key: SeriesKey = {
      exercise: exercise.name,
      ...(exercise.defId !== undefined ? {defId: exercise.defId} : {}),
      occurrence,
    }
    const left = sidePerformance(history, key, 'L')
    const right = sidePerformance(history, key, 'R')
    if (left === undefined && right === undefined) continue
    out.push({
      exercise: exercise.name,
      key: rowKey,
      ...(exercise.defId !== undefined ? {defId: exercise.defId} : {}),
      occurrence,
      left: left?.weight,
      right: right?.weight,
      leftReps: left?.reps,
      rightReps: right?.reps,
      rightAhead: left !== undefined && right !== undefined
        && (right.weight > left.weight
          || (right.weight === left.weight && right.reps > left.reps)),
    })
  }
  return out
}

export interface Stall {
  exercise: string
  /** Unique to the row — see `programOccurrences`. */
  key: string
  occurrence: number
  weight: number
  sessions: number
  /** The reps behind the stall — each of the latest sessions' `judgedSets`,
   *  newest first. A set-to-set fade across them is what tells a lift that is
   *  stuck apart from one that is tired. */
  recent: readonly (readonly number[])[]
}

const RECENT_SESSIONS = 3

/** Every lift sitting at one load for long enough to look at, in program
 *  order. */
export const stalledLifts = (
  history: readonly WorkoutRecord[],
  config: ProgramConfig,
): Stall[] =>
  programOccurrences(config.exercises).flatMap(({item, occurrence, key}) => {
    const sessions = sessionsNewestFirst(history, item.name, item.defId, occurrence)
    const stall = stallIn(sessions)
    if (!stall) return []
    const recent = sessions
      .slice(0, RECENT_SESSIONS)
      .map(({entry}) => judgedSets(entry, item)?.sets.map(set => set.reps) ?? [])
    return [{exercise: item.name, key, occurrence, ...stall, recent}]
  })

/** Each load-progressed lift's latest working weight, by name.
 *
 *  By name because that is how the review states a ratio. Where two plan lines
 *  share one (a lift's heavy track and its light second exposure), the heavier
 *  number stands for the lift — the light track is volume, not a measure of
 *  what the lift can do. */
export const currentWeights = (
  history: readonly WorkoutRecord[],
  config: ProgramConfig,
): Map<string, number> => {
  const weights = new Map<string, number>()
  for (const {item, occurrence} of programOccurrences(config.exercises)) {
    if (item.freeform) continue
    const last = lastEntryFor(history, item.name, item.defId, occurrence)
    const weight = last ? workingWeight(last.entry) : undefined
    if (weight === undefined) continue
    weights.set(item.name, Math.max(weight, weights.get(item.name) ?? weight))
  }
  return weights
}

export interface LiftBalance {
  ratios: {ratio: LiftRatio; value?: number}[]
  /** Whether `heaviestLift` is strictly ahead of every other lift, with the
   *  closest one for comparison. Absent until it and one other lift have been
   *  logged — with nothing to compare, "heaviest" says nothing. */
  heaviest?: {lift: string; weight: number; holds: boolean; runnerUp: {lift: string; weight: number}}
}

export const liftBalance = (
  history: readonly WorkoutRecord[],
  config: ProgramConfig,
): LiftBalance => {
  const weights = currentWeights(history, config)
  const ratios = config.ratios.map(ratio => {
    const numerator = weights.get(ratio.numerator)
    const denominator = weights.get(ratio.denominator)
    return numerator !== undefined && denominator !== undefined && denominator > 0
      ? {ratio, value: numerator / denominator}
      : {ratio}
  })
  const lift = config.heaviestLift
  const weight = lift !== undefined ? weights.get(lift) : undefined
  if (lift === undefined || weight === undefined) return {ratios}
  let runnerUp: {lift: string; weight: number} | undefined
  for (const [other, otherWeight] of weights) {
    if (other !== lift && (runnerUp === undefined || otherWeight > runnerUp.weight)) {
      runnerUp = {lift: other, weight: otherWeight}
    }
  }
  if (runnerUp === undefined) return {ratios}
  return {ratios, heaviest: {lift, weight, holds: weight > runnerUp.weight, runnerUp}}
}
