/** The re-entry table — the mechanism the plan calls 80% of the value.
 *
 *  Gap is measured between *full* sessions (A/B) in training days; mini
 *  days are logged but deliberately don't reset the clock. The tier
 *  selected on the first night back is then held for `sessionsToNormal`
 *  full sessions, ramping by `rampPerSession`, before normal double
 *  progression resumes.
 *
 *  Two states, one shape:
 *   - *pending* — a gap detected right now that hasn't been recorded as a
 *     layoff block yet. This is the first night back; `sessionsBack` is 0.
 *   - *recorded* — a layoff block exists; `sessionsBack` counts the full
 *     sessions logged on or after the day training resumed.
 *
 *  Percentages always apply to *pre-break* weights (sessions on or before
 *  `from`), never to the reduced weights logged during the ramp — otherwise
 *  the second night back would prescribe 90% of 90%.
 */

import {daysBetween, fullSessionDays, trainingDay} from './schedule'
import type {
  LayoffRecord,
  ProgramConfig,
  ReentryStatus,
  ReentryTier,
  WorkoutRecord,
} from './types'
import {isFullSession, isOnScheduleTier} from './types'

/** First tier whose bound the gap fits under. Tiers are sorted defensively
 *  so a hand-edited config block in the wrong order still classifies
 *  correctly. */
export const tierFor = (
  gapDays: number,
  tiers: readonly ReentryTier[],
): ReentryTier | undefined =>
  [...tiers].sort((a, b) => a.maxGapDays - b.maxGapDays).find(t => gapDays <= t.maxGapDays)

export interface PendingLayoff {
  from: string
  to: string
  days: number
  tier: ReentryTier
}

/** A gap that is live right now and not yet written down. Returns null on
 *  a first-ever session (nothing to come back from) and on schedule. */
export const detectPendingLayoff = (
  history: readonly WorkoutRecord[],
  day: string,
  config: ProgramConfig,
): PendingLayoff | null => {
  const days = fullSessionDays(history, config.dayRolloverHour)
  const last = days.at(-1)
  if (last === undefined) return null
  // Already trained today (or the clock is skewed) — no gap to classify.
  if (last >= day) return null

  const gap = daysBetween(last, day)
  const tier = tierFor(gap, config.reentry)
  if (!tier || isOnScheduleTier(tier)) return null
  return {from: last, to: day, days: gap, tier}
}

/** The tier a RECORDED layoff actually applies — the one resolution, used by
 *  everything that asks how deep a recorded break was.
 *
 *  `strength:reentryPct` is stored on the record too, but nothing reads it to
 *  decide anything: the load factor comes from this tier's `pct` and
 *  `rampPerSession`. Both are ordinary editable properties, so they can be
 *  edited apart — and a comparison against the stored percentage then passes
 *  while the tier that actually governs says something else entirely. That is
 *  not only a race: a record whose `strength:tier` reads `on-schedule` applies
 *  NO cut however deep its stored percentage claims to be.
 *
 *  `days` is the fallback because an unrecognised tier id (renamed in the plan,
 *  or typed by hand) still has a gap length to classify by — the same rule
 *  `detectPendingLayoff` used to pick the tier in the first place. */
export const effectiveTier = (
  record: {tierId: string; days: number},
  config: ProgramConfig,
): ReentryTier | undefined =>
  config.reentry.find(tier => tier.id === record.tierId) ?? tierFor(record.days, config.reentry)

const factorFor = (tier: ReentryTier, sessionsBack: number): number =>
  Math.min(1, tier.pct + tier.rampPerSession * sessionsBack)

const bannerFor = (
  tier: ReentryTier,
  gapDays: number,
  sessionsBack: number,
  factor: number,
): string => {
  const pct = `${Math.round(factor * 100)}%`
  const head = `${gapDays}-day gap → ${tier.label} layoff`
  const body = factor < 1 ? `${pct} of pre-break weights` : 'same weights'
  const ordinal = sessionsBack === 0 ? 'first session back' : `session ${sessionsBack + 1} back`
  return `${head} → ${body} (${ordinal})`
}

/** The active re-entry state for `day`, or undefined when training is on
 *  schedule / the ramp has finished. */
export const resolveReentry = (
  history: readonly WorkoutRecord[],
  layoffs: readonly LayoffRecord[],
  day: string,
  config: ProgramConfig,
): ReentryStatus | undefined => {
  const pending = detectPendingLayoff(history, day, config)
  if (pending) {
    const factor = factorFor(pending.tier, 0)
    return {
      tier: pending.tier,
      gapDays: pending.days,
      from: pending.from,
      sessionsBack: 0,
      factor,
      pending: true,
      banner: bannerFor(pending.tier, pending.days, 0, factor),
    }
  }

  const latest = [...layoffs].sort((a, b) => a.to.localeCompare(b.to)).at(-1)
  if (!latest) return undefined

  const tier = effectiveTier(latest, config)
  if (!tier || isOnScheduleTier(tier)) return undefined

  const sessionsBack = fullSessionDays(history, config.dayRolloverHour)
    .filter(d => d >= latest.to)
    .length
  if (sessionsBack >= tier.sessionsToNormal) return undefined

  const factor = factorFor(tier, sessionsBack)
  return {
    tier,
    gapDays: latest.days,
    from: latest.from,
    sessionsBack,
    factor,
    pending: false,
    banner: bannerFor(tier, latest.days, sessionsBack, factor),
  }
}

/** Layoff record for a pending gap, ready to be written as a block. The
 *  caller stamps the id. */
export const layoffFromPending = (pending: PendingLayoff): Omit<LayoffRecord, 'id'> => ({
  from: pending.from,
  to: pending.to,
  days: pending.days,
  tierId: pending.tier.id,
  pct: pending.tier.pct,
})

/** Convenience for the km layer: has this gap already been written down, at
 *  least as severely as we are now measuring it?
 *
 *  `from` identifies the break — one break has one pre-break session, which is
 *  why the record is keyed on it — but it does not settle how DEEP the break
 *  was, and that is re-measurable. Finish a comeback session and then untick
 *  every set of it (the only correction available once a session is closed)
 *  and `buildHistory` stops counting it as a training day, so the next real
 *  return measures the SAME break across a longer gap. On `from` alone that
 *  read as "already recorded" and wrote nothing, leaving the record naming the
 *  comeback that was taken back: a lighter tier, and an earlier `to` that
 *  inflates `sessionsBack`, so `resolveReentry` ramps back to full loads
 *  faster than the real break warrants.
 *
 *  Compared on SEVERITY (`pct`, the fraction of pre-break weights) rather than
 *  on `to`, and this is the load-bearing choice. Two clients coming back from
 *  one break can date the return differently — one has not synced the other's
 *  session — and there is no way to tell that apart from a retraction by
 *  looking at either one's history. Comparing dates would make the later write
 *  win and move a correctly-recorded return; comparing severity means a record
 *  only ever gets HARSHER. So the two clients converge on the deepest
 *  measurement whatever order they land in, and a re-measurement can never
 *  make re-entry more aggressive than the record it replaces — which is the
 *  direction that would put weight on a bar.
 *
 *  The residue, stated: a retraction that does NOT cross a tier boundary
 *  leaves `to` a little early, so `sessionsBack` runs one session ahead. Same
 *  tier, same cut.
 *
 *  Severity is read through `effectiveTier`, NOT off the record's stored
 *  `pct`. The stored value decides nothing — `resolveReentry` takes the factor
 *  from the tier — so comparing it accepted a record whose `strength:tier` had
 *  been edited to something shallower, or to `on-schedule`, which applies no
 *  cut at all. An unresolvable tier is treated as covering nothing, since a
 *  record that cannot say how deep the break was cannot stand in for one. */
export const coveringLayoff = (
  pending: PendingLayoff,
  layoffs: readonly LayoffRecord[],
  config: ProgramConfig,
): LayoffRecord | undefined => layoffs.find(record => {
  if (record.from !== pending.from) return false
  const tier = effectiveTier(record, config)
  return tier !== undefined && !isOnScheduleTier(tier) && tier.pct <= pending.tier.pct
})

export const layoffAlreadyRecorded = (
  pending: PendingLayoff,
  layoffs: readonly LayoffRecord[],
  config: ProgramConfig,
): boolean => coveringLayoff(pending, layoffs, config) !== undefined

/** Training day of a workout, re-exported here so callers building layoff
 *  records don't have to reach into `schedule` for one helper. */
export const workoutDay = (workout: WorkoutRecord, config: ProgramConfig): string =>
  trainingDay(workout.date, config.dayRolloverHour)

/** The workouts that establish the last full session day — the one fact the
 *  whole layoff decision turns on.
 *
 *  `detectPendingLayoff` measures the gap FROM that day, so it alone fixes the
 *  tier, and it is read from a history snapshot taken before the finishing
 *  transaction opens. Untick every set of that session inside the window (the
 *  only correction available once a session is closed) and it stops being a
 *  training day, so the real gap is longer than the snapshot says — and the
 *  finish commits with no layoff record, or a light one. Once the closing
 *  session joins history the gap is undetectable on every later day, so the
 *  re-entry cut is lost for good rather than merely wrong.
 *
 *  Returned as BLOCK IDS, so the finishing transaction can re-check them by id
 *  — which is the only shape it can check, having no workspace-wide query. They
 *  are also the only rows whose retraction changes the answer: a workout on an
 *  EARLIER day is not what `from` reads, and one arriving LATER only shortens
 *  the gap, which is the conservative direction.
 *
 *  Every workout on that day, not just one: the day survives as long as any
 *  full session on it does.
 *
 *  Carries the DATE as well as the id, because existing is not the same as
 *  still being on that day. `strength:date` is hand-editable, so a basis
 *  workout re-dated to an older day keeps all its done sets — an id-only check
 *  passes while the gap it anchors has silently grown. The value is the
 *  normalised instant `buildHistory` derives (`storedDate(raw).toISOString()`),
 *  so the transaction can rebuild it from the raw property with no config and
 *  no rollover arithmetic. */
export interface BasisWorkout {
  id: string
  /** `WorkoutRecord.date` — the normalised ISO instant, not the raw property. */
  date: string
}

export const lastFullSessionBasis = (
  history: readonly WorkoutRecord[],
  config: ProgramConfig,
): BasisWorkout[] => {
  const full = history.filter(workout => isFullSession(workout.session))
  const latest = full.reduce<string | undefined>(
    (best, workout) => {
      const day = workoutDay(workout, config)
      return best === undefined || day > best ? day : best
    },
    undefined,
  )
  return latest === undefined
    ? []
    : full
      .filter(workout => workoutDay(workout, config) === latest)
      .map(workout => ({id: workout.id, date: workout.date}))
}
