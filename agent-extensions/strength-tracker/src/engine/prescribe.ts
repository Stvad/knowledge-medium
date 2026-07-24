/** `(history, config, today) → prescription`.
 *
 *  The single entry point the UI calls. Everything it needs to explain
 *  itself — which tier fired, what the pre-break weight was, why a lift
 *  went up — is in the returned value; no component re-derives program
 *  logic.
 */

import {lastEntryFor, nextWeight, roundLoad, workingWeight} from './progression'
import {resolveReentry} from './reentry'
import {daysBetween, resolveSession, trainingDay} from './schedule'
import type {
  ExerciseConfig,
  LayoffRecord,
  PrescribedExercise,
  Prescription,
  ProgramConfig,
  ReentryStatus,
  SessionType,
  WorkoutRecord,
} from './types'

export interface PrescribeInput {
  history: readonly WorkoutRecord[]
  layoffs: readonly LayoffRecord[]
  config: ProgramConfig
  now: Date | string
  /** Manual override from the UI ("I'm doing B tonight instead"). */
  session?: SessionType
}

/** Sets prescribed under an active tier. `setsOverride` is the "2 sets per
 *  lift" rows; `setsDelta` is the "drop 1 set, first session only" row. */
const setsFor = (config: ExerciseConfig, reentry: ReentryStatus | undefined): number => {
  if (!reentry) return config.sets
  const {tier, sessionsBack} = reentry
  const overrideWindow = tier.setsOverrideSessions ?? Infinity
  if (tier.setsOverride !== undefined && sessionsBack < overrideWindow) {
    return Math.max(1, tier.setsOverride)
  }
  if (sessionsBack === 0 && tier.setsDelta) return Math.max(1, config.sets - tier.setsDelta)
  return config.sets
}

const repsFor = (
  config: ExerciseConfig,
  reentry: ReentryStatus | undefined,
): {repMin?: number; repMax?: number} => {
  const tier = reentry?.tier
  if (tier?.repMin !== undefined || tier?.repMax !== undefined) {
    return {repMin: tier.repMin ?? config.repMin, repMax: tier.repMax ?? config.repMax}
  }
  return {repMin: config.repMin, repMax: config.repMax}
}

const shortDay = (day: string): string => day.slice(5)

const prescribeExercise = (
  exercise: ExerciseConfig,
  basis: readonly WorkoutRecord[],
  reentry: ReentryStatus | undefined,
  day: string,
  config: ProgramConfig,
): PrescribedExercise => {
  const sets = setsFor(exercise, reentry)
  const {repMin, repMax} = repsFor(exercise, reentry)
  const last = lastEntryFor(basis, exercise.name)
  const lastWeight = last ? workingWeight(last.entry) : undefined
  const lastTime = last && lastWeight !== undefined
    ? {
      date: trainingDay(last.workout.date, config.dayRolloverHour),
      weight: lastWeight,
      reps: last.entry.sets.map(s => s.reps),
    }
    : undefined

  const base: Omit<PrescribedExercise, 'weight' | 'rationale'> = {
    exercise: exercise.name,
    sets,
    repMin,
    repMax,
    perSide: exercise.perSide,
    freeform: exercise.freeform,
    note: exercise.note,
    lastTime,
  }

  if (!last || lastWeight === undefined) {
    return {
      ...base,
      weight: undefined,
      rationale: 'no history yet — pick a weight you stop 2 reps shy of (RPE 8)',
    }
  }

  // Deep recorded layoff (pct < 1): the whole body is detrained, so cut
  // load off the pre-break weight regardless of the individual lift.
  if (reentry && reentry.factor < 1) {
    const weight = roundLoad(lastWeight * reentry.factor, config.roundTo)
    return {
      ...base,
      weight,
      rationale: `${Math.round(reentry.factor * 100)}% of ${lastWeight} (pre-break, ${shortDay(lastTime!.date)})`,
    }
  }

  if (exercise.freeform) {
    return {
      ...base,
      weight: lastWeight,
      rationale: `${lastWeight} last time — add load when it feels easy, not on a schedule`,
    }
  }

  // Per-lift cadence: with no load cut in force, a lift trained beyond its
  // weekly cadence repeats rather than progresses ("missed 1 session →
  // repeat last weights"). This also delivers the 1–2 week row's "same
  // weights first session, normal the second" for free — the comeback
  // session brings the lift back inside cadence, so the next one progresses.
  const cadenceGap = daysBetween(lastTime!.date, day)
  const heldForCadence = cadenceGap > config.perLiftCadenceDays

  const step = nextWeight(last.entry, exercise, {hold: heldForCadence})
  if (!step) {
    return {...base, weight: undefined, rationale: 'no usable history — pick a weight at RPE 8'}
  }

  if (heldForCadence) {
    const why = reentry
      ? `same weights — ${reentry.tier.label}`
      : `${cadenceGap} days since last ${exercise.name.toLowerCase()} → repeat, no jump`
    return {...base, weight: step.weight, rationale: why}
  }
  if (step.progressed) {
    const target = last.entry.prescribedSets ?? exercise.sets
    return {
      ...base,
      weight: step.weight,
      rationale: `${target}×${repMax} at ${lastWeight} cleared → +${exercise.increment}`,
    }
  }
  const reps = lastTime!.reps.join(', ')
  return {
    ...base,
    weight: step.weight,
    rationale: repMax === undefined
      ? `${step.weight} last time (${reps})`
      : `hold ${step.weight} until ${sets}×${repMax} (last: ${reps})`,
  }
}

export const prescribe = (input: PrescribeInput): Prescription => {
  const {history, layoffs, config} = input
  const day = trainingDay(input.now, config.dayRolloverHour)

  const resolved = resolveSession(day, history, config)
  const session = input.session ?? resolved.session
  const offSchedule = input.session ? input.session !== resolved.session || resolved.offSchedule : resolved.offSchedule

  const reentry = resolveReentry(history, layoffs, day, config)

  // Basis for "what did I lift last time": everything before tonight, and —
  // while a layoff ramp is live — everything up to the pre-break session, so
  // percentages compound off real weights instead of off the reduced ones.
  const cutoff = reentry ? reentry.from : day
  const basis = history.filter(w => {
    const d = trainingDay(w.date, config.dayRolloverHour)
    return reentry ? d <= cutoff : d < cutoff
  })

  const exercises = config.exercises
    .filter(e => e.session === session)
    .map(e => prescribeExercise(e, basis, reentry, day, config))

  const notes = [
    ...(config.sessionNotes[session] ?? []),
    ...(reentry ? [reentry.tier.guidance] : []),
  ]

  return {day, session, offSchedule, exercises, reentry, notes}
}
