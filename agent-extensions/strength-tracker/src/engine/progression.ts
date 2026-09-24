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

import {compareRecords} from './types'
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

/** Does this logged entry belong to the exercise we're asking about?
 *
 *  Identity wins over spelling: when the entry and the config both name a
 *  plan block, only that decides — so renaming a lift in the plan keeps its
 *  progression line, and two same-named definitions stay separate lines.
 *  Whenever either side lacks one (entries logged before the plan blocks
 *  were typed, a hand-written plan, callers that only know a name) it falls
 *  back to matching the name, which is what the log has always used.
 *
 *  So an untagged entry matches EVERY definition of its name. Legacy entries
 *  are backfilled with their definition rather than disambiguated here, and in
 *  a plan without blocks one name in two sessions is one lift, not two. */
const entryMatches = (entry: ExerciseRecord, exercise: string, defId?: string): boolean =>
  defId !== undefined && entry.definitionId !== undefined
    ? entry.definitionId === defId
    : entry.exercise === exercise

/** This lift's entry in one workout, if it has one with sets logged.
 *
 *  `occurrence` is which time in the session the row is, when the caller
 *  knows. A session can prescribe one lift twice at two different loads, and
 *  taking the first match gave BOTH rows the same baseline — so the second
 *  progressed off the first's weight, and reordering the finished entries
 *  could swap which. */
const entryIn = (
  workout: WorkoutRecord,
  exercise: string,
  defId: string | undefined,
  occurrence: number | undefined,
): ExerciseRecord | undefined => {
  const candidates = workout.exercises.filter(e => entryMatches(e, exercise, defId))
  // Falling back to "the first match" per WORKOUT let a newer session that
  // logged only the FIRST Squat outrank an older one that logged both — so
  // a lookup for the second row took the first row's load again, by a
  // different route. The only fallback that is not a wrong answer is a
  // record that states no occurrence at all, which is every record written
  // before entries stored the number; otherwise keep looking further back.
  const entry = occurrence === undefined
    ? candidates[0]
    : candidates.find(e => e.occurrence === occurrence)
      ?? candidates.find(e => e.occurrence === undefined)
  return entry && entry.sets.length > 0 ? entry : undefined
}

/** Most recent logged entry for an exercise, or undefined. `history` may
 *  arrive in any order; the caller's day ordering is not assumed. */
export const lastEntryFor = (
  history: readonly WorkoutRecord[],
  exercise: string,
  defId?: string,
  occurrence?: number,
): {workout: WorkoutRecord; entry: ExerciseRecord} | undefined => {
  let best: {workout: WorkoutRecord; entry: ExerciseRecord} | undefined
  for (const workout of history) {
    const entry = entryIn(workout, exercise, defId, occurrence)
    if (!entry) continue
    if (!best || compareRecords(workout, best.workout) > 0) best = {workout, entry}
  }
  return best
}

/** This lift's logged sessions, newest first, each with its working weight. */
export const sessionsNewestFirst = (
  history: readonly WorkoutRecord[],
  exercise: string,
  defId?: string,
  occurrence?: number,
): {workout: WorkoutRecord; entry: ExerciseRecord; weight: number}[] =>
  history
    .flatMap(workout => {
      const entry = entryIn(workout, exercise, defId, occurrence)
      const weight = entry ? workingWeight(entry) : undefined
      return entry && weight !== undefined ? [{workout, entry, weight}] : []
    })
    .sort((a, b) => compareRecords(b.workout, a.workout))

/** A lift at one load for this many sessions is worth a second look, whether
 *  the engine is holding it or the lift is progressed by hand. */
export const STALL_SESSIONS = 4

/** The load a lift has sat at for `STALL_SESSIONS` or more, and for how many
 *  sessions, read off one newest-first list so the weight and the count
 *  describe the same run. Unloaded work (0) has no load to be stuck at — a
 *  band exercise logged at 0 for months is on plan. */
export const stallIn = (
  sessions: readonly {weight: number}[],
): {weight: number; sessions: number} | undefined => {
  const weight = sessions[0]?.weight
  if (weight === undefined || weight <= 0) return undefined
  const end = sessions.findIndex(session => session.weight !== weight)
  const run = end === -1 ? sessions.length : end
  return run >= STALL_SESSIONS ? {weight, sessions: run} : undefined
}

export const stallOf = (
  history: readonly WorkoutRecord[],
  exercise: string,
  defId?: string,
  occurrence?: number,
): {weight: number; sessions: number} | undefined =>
  stallIn(sessionsNewestFirst(history, exercise, defId, occurrence))

/** The sets at the modal weight of `sets`, in the order they were logged. */
export const setsAtModalWeight = (
  sets: readonly SetRecord[],
): {weight: number; sets: readonly SetRecord[]} | undefined => {
  const weight = modalWeight(sets)
  return weight === undefined ? undefined : {weight, sets: sets.filter(s => s.weight === weight)}
}

/** The sets that count toward progression, at the working weight. Warm-ups,
 *  drop sets and back-offs at other loads say nothing about the working
 *  weight. */
export const setsAtWorkingWeight = (
  entry: ExerciseRecord,
): {weight: number; sets: readonly SetRecord[]} | undefined =>
  setsAtModalWeight(progressionSets(entry.sets))

/** How many sets a session is judged against: what was prescribed at the
 *  time, not today's config. */
export const setTarget = (entry: ExerciseRecord, config: Pick<ExerciseConfig, 'sets'>): number =>
  entry.prescribedSets ?? config.sets

/** The first `setTarget` sets at the working weight — the sets a session is
 *  judged by, and the ones shown as its evidence. A set added past the
 *  prescription neither blocks a top-out, buys a step, nor reads as a fade. */
export const judgedSets = (
  entry: ExerciseRecord,
  config: Pick<ExerciseConfig, 'sets'>,
): {weight: number; sets: readonly SetRecord[]} | undefined => {
  const working = setsAtWorkingWeight(entry)
  return working && {weight: working.weight, sets: working.sets.slice(0, setTarget(entry, config))}
}

/** `judgedSets`, when every prescribed set was done at the weight — the
 *  progression rules judge nothing less. */
const workingSets = (
  entry: ExerciseRecord,
  config: Pick<ExerciseConfig, 'sets'>,
): {weight: number; sets: readonly SetRecord[]} | undefined => {
  const judged = judgedSets(entry, config)
  return judged && judged.sets.length >= setTarget(entry, config) ? judged : undefined
}

const toppedIn = (
  sets: readonly SetRecord[],
  config: Pick<ExerciseConfig, 'repMax' | 'freeform'>,
): boolean =>
  !config.freeform && config.repMax !== undefined && sets.every(s => s.reps >= config.repMax!)

/** True when every prescribed set hit the top of the range at the working
 *  weight. Freeform work (no rep range) never tops out — it isn't
 *  load-progressed at all. */
export const toppedOut = (
  entry: ExerciseRecord,
  config: Pick<ExerciseConfig, 'sets' | 'repMax' | 'freeform'>,
): boolean => {
  const working = workingSets(entry, config)
  return working !== undefined && toppedIn(working.sets, config)
}

/** The reps the total-reps rule counts, in order. Undefined when fewer than
 *  the prescribed sets were done at the working weight. */
export const countedReps = (
  entry: ExerciseRecord,
  config: Pick<ExerciseConfig, 'sets'>,
): number[] | undefined => workingSets(entry, config)?.sets.map(s => s.reps)

export const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

/** Which rule moved the weight. The rationale names it, so it is returned
 *  rather than re-derived from the size of the jump. */
export type ProgressionRule = 'increment' | 'catch-up' | 'ladder' | 'total-reps'

export type ProgressionStep =
  | {weight: number; progressed: false}
  | {weight: number; progressed: true; rule: ProgressionRule}

/** The lightest rung above `weight`; undefined with no ladder, or at its top. */
export const nextRung = (ladder: readonly number[] | undefined, weight: number): number | undefined =>
  ladder?.find(rung => rung > weight)

/** The heaviest rung at or below `weight` — a cut load put onto a weight that
 *  exists. Below the bottom rung, the bottom rung: nothing lighter exists. */
export const rungAtOrBelow = (ladder: readonly number[], weight: number): number =>
  ladder.filter(rung => rung <= weight).at(-1) ?? ladder[0]

type StepConfig = Pick<
  ExerciseConfig,
  | 'sets' | 'repMax' | 'freeform' | 'increment' | 'catchUpIncrement' | 'catchUpRpe'
  | 'totalRepsThreshold' | 'microIncrement' | 'ladder'
>

/** The step for a session that topped out. A ladder lists the loads that
 *  exist, so it outranks both increments; past its top rung there is nothing
 *  listed, and the increment applies as if there were no ladder.
 *
 *  The catch-up jump needs every working set rated at or below the ceiling —
 *  an unrated set is no evidence it was easy. */
const toppedStep = (
  working: {weight: number; sets: readonly SetRecord[]},
  config: StepConfig,
): ProgressionStep => {
  const {weight, sets} = working
  const rung = nextRung(config.ladder, weight)
  if (rung !== undefined) return {weight: rung, progressed: true, rule: 'ladder'}
  const {catchUpIncrement, catchUpRpe} = config
  if (
    catchUpIncrement !== undefined && catchUpRpe !== undefined &&
    sets.length > 0 && sets.every(s => s.rpe !== undefined && s.rpe <= catchUpRpe)
  ) {
    return {weight: weight + catchUpIncrement, progressed: true, rule: 'catch-up'}
  }
  return {weight: weight + config.increment, progressed: true, rule: 'increment'}
}

/** Whether a lift runs the total-reps rule at all: it needs both numbers, and
 *  never on a ladder — the micro step lands between rungs, on a load that does
 *  not exist. */
export const totalRepsRule = (
  config: Pick<ExerciseConfig, 'freeform' | 'totalRepsThreshold' | 'microIncrement' | 'ladder'>,
): {threshold: number; increment: number} | undefined =>
  config.freeform || config.ladder || config.totalRepsThreshold === undefined || config.microIncrement === undefined
    ? undefined
    : {threshold: config.totalRepsThreshold, increment: config.microIncrement}

/** Next weight for an exercise given its last logged entry. `hold`
 *  suppresses the jump — the "missed 1 session → repeat last weights" row. */
export const nextWeight = (
  entry: ExerciseRecord,
  config: StepConfig,
  opts: {hold?: boolean} = {},
): ProgressionStep | undefined => {
  const weight = workingWeight(entry)
  if (weight === undefined) return undefined
  const working = opts.hold ? undefined : workingSets(entry, config)
  if (!working) return {weight, progressed: false}
  if (toppedIn(working.sets, config)) return toppedStep(working, config)
  const rule = totalRepsRule(config)
  if (rule && sum(working.sets.map(s => s.reps)) >= rule.threshold) {
    return {weight: weight + rule.increment, progressed: true, rule: 'total-reps'}
  }
  return {weight, progressed: false}
}

/** Round a percentage-derived load onto loadable plates. Rounds down: at
 *  1am, coming back from a break, the error should be on the light side. */
export const roundLoad = (weight: number, roundTo: number): number => {
  if (roundTo <= 0) return weight
  return Math.floor(weight / roundTo) * roundTo
}
