/** `(history, config, today) → prescription`.
 *
 *  The single entry point the UI calls. Everything it needs to explain
 *  itself — which tier fired, what the pre-break weight was, why a lift
 *  went up — is in the returned value; no component re-derives program
 *  logic.
 */

import {
  countedReps,
  lastEntryFor,
  nextRung,
  nextWeight,
  roundLoad,
  rungAtOrBelow,
  setTarget,
  stallOf,
  sum,
  totalRepsRule,
  workingWeight,
  type ProgressionRule,
} from './progression'
import {resolveReentry} from './reentry'
import {daysBetween, resolveSession, trainingDay} from './schedule'
import {programOccurrences} from './types'
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
    const mixed = {repMin: tier.repMin ?? config.repMin, repMax: tier.repMax ?? config.repMax}
    // The tier may state only ONE end, and the other then comes from the
    // lift — so a window that is rising on both sides separately can still
    // invert once mixed (a tier's `repMin: 12` over a lift capped at 10).
    // The parser cannot catch this one: it depends on which exercise the
    // tier lands on. An inverted window reaches `setsFor`, which stamps
    // `repMax ?? repMin` and quietly prescribes the lower number while the
    // range claims the higher — so keep the lift's own window instead.
    if (mixed.repMin === undefined || mixed.repMax === undefined || mixed.repMin < mixed.repMax) {
      return mixed
    }
  }
  return {repMin: config.repMin, repMax: config.repMax}
}

const shortDay = (day: string): string => day.slice(5)

/** Why the weight went up, in the plan's own terms. */
const progressedBecause = (
  rule: ProgressionRule,
  exercise: ExerciseConfig,
  lastWeight: number,
  weight: number,
  cleared: string,
): string => {
  switch (rule) {
    case 'increment': return `${cleared} → +${weight - lastWeight}`
    case 'catch-up': return `${cleared} → +${weight - lastWeight} (catch-up, RPE ≤ ${exercise.catchUpRpe})`
    case 'ladder': return `${cleared} → next rung, ${weight}`
    case 'total-reps': return `${exercise.totalRepsThreshold}+ total reps at ${lastWeight} → +${weight - lastWeight}`
  }
}

const prescribeExercise = (
  exercise: ExerciseConfig,
  basis: readonly WorkoutRecord[],
  reentry: ReentryStatus | undefined,
  day: string,
  config: ProgramConfig,
  occurrence: number,
): PrescribedExercise => {
  const sets = setsFor(exercise, reentry)
  const {repMin, repMax} = repsFor(exercise, reentry)
  const last = lastEntryFor(basis, exercise.name, exercise.defId, occurrence)
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
    defId: exercise.defId,
    sets,
    repMin,
    repMax,
    perSide: exercise.perSide,
    freeform: exercise.freeform,
    note: exercise.note,
    videos: exercise.videos,
    altGroupKey: exercise.altGroupKey,
    altOptions: exercise.altOptions,
    // Both, or neither: `toppedStep` only consults the ceiling when there
    // is a bigger jump to award, so a plan that sets one without the other
    // would otherwise have the UI collecting an RPE nothing ever reads.
    ...(exercise.catchUpIncrement !== undefined && exercise.catchUpRpe !== undefined
      ? {catchUpRpe: exercise.catchUpRpe}
      : {}),
    lastTime,
  }

  if (!last || lastWeight === undefined) {
    if (exercise.startWeight !== undefined) {
      const {startWeight, ladder} = exercise
      const start = ladder ? rungAtOrBelow(ladder, startWeight) : startWeight
      return {
        ...base,
        weight: start,
        rationale: start === startWeight
          ? `first session — start at ${start}, per the plan`
          : `first session — start at ${start}, the rung at or below the plan's ${startWeight}`,
      }
    }
    return {
      ...base,
      weight: undefined,
      rationale: 'no history yet — pick a weight you stop 2 reps shy of (RPE 8)',
    }
  }

  // Deep recorded layoff (pct < 1): the whole body is detrained, so cut
  // load off the pre-break weight regardless of the individual lift.
  if (reentry && reentry.factor < 1) {
    const cut = lastWeight * reentry.factor
    const weight = exercise.ladder ? rungAtOrBelow(exercise.ladder, cut) : roundLoad(cut, config.roundTo)
    return {
      ...base,
      weight,
      rationale: `${Math.round(reentry.factor * 100)}% of ${lastWeight} (pre-break, ${shortDay(lastTime!.date)})`,
    }
  }

  const stall = (): {weight: number; sessions: number} | undefined =>
    stallOf(basis, exercise.name, exercise.defId, occurrence)

  if (exercise.freeform) {
    const stalled = stall()
    if (stalled) {
      const rung = nextRung(exercise.ladder, lastWeight)
      return {
        ...base,
        weight: lastWeight,
        rationale: `${lastWeight} for ${stalled.sessions} sessions — ${rung !== undefined ? `step up to ${rung}` : 'add load'} when it feels easy`,
      }
    }
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
    const target = setTarget(last.entry, exercise)
    return {
      ...base,
      weight: step.weight,
      rationale: progressedBecause(step.rule, exercise, lastWeight, step.weight, `${target}×${repMax} at ${lastWeight} cleared`),
    }
  }
  const reps = lastTime!.reps.join(', ')
  if (repMax === undefined) return {...base, weight: step.weight, rationale: `${step.weight} last time (${reps})`}
  // The total names the reps it counted, which are not always every set logged.
  const totalRule = totalRepsRule(exercise)
  const counted = totalRule ? countedReps(last.entry, exercise) : undefined
  const total = totalRule && counted
    ? ` or ${totalRule.threshold} total (last: ${counted.join(', ')} = ${sum(counted)})`
    : ` (last: ${reps})`
  const stalled = stall()
  return {
    ...base,
    weight: step.weight,
    rationale: `hold ${step.weight} until ${sets}×${repMax}${total}${stalled ? ` · ${stalled.sessions} sessions at ${stalled.weight}` : ''}`,
  }
}

export const prescribe = (input: PrescribeInput): Prescription => {
  const {history, layoffs, config} = input
  const day = trainingDay(input.now, config.dayRolloverHour)

  const resolved = resolveSession(day, history, config)
  const session = input.session ?? resolved.session
  const offSchedule = input.session ? input.session !== resolved.session || resolved.offSchedule : resolved.offSchedule

  const reentry = resolveReentry(history, layoffs, day, config)

  // Basis for "what did I lift last time": everything up to and including
  // tonight, and — while a layoff ramp is live — everything up to the
  // pre-break session, so percentages compound off real weights instead of
  // off the reduced ones.
  //
  // `<=` on the normal branch, not `<`. `history` holds only FINISHED
  // sessions, so the only thing today's date can contribute is a session
  // already closed — which is the supported repeat: finish Session A, start
  // Session A again the same day. Excluding it prescribed the repeat from
  // YESTERDAY, ignoring the weights and reps just logged, and dropping the
  // progression the morning session had earned. Nothing in progress is in
  // here to be read prematurely.
  const cutoff = reentry ? reentry.from : day
  const basis = history.filter(w =>
    trainingDay(w.date, config.dayRolloverHour) <= cutoff)

  // A lift prescribed twice is two rows, and each progresses off ITS OWN
  // history.
  const exercises = programOccurrences(config.exercises.filter(e => e.session === session))
    .map(({item, occurrence}) => prescribeExercise(item, basis, reentry, day, config, occurrence))

  const notes = [
    ...(config.sessionNotes[session] ?? []),
    ...(reentry ? [reentry.tier.guidance] : []),
  ]

  return {day, session, offSchedule, exercises, reentry, notes}
}
