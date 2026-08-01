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
import {isOnScheduleTier} from './types'

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

  const tier =
    config.reentry.find(t => t.id === latest.tierId) ?? tierFor(latest.days, config.reentry)
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
 *  tier, same cut. */
export const layoffAlreadyRecorded = (
  pending: PendingLayoff,
  layoffs: readonly LayoffRecord[],
): boolean => layoffs.some(l => l.from === pending.from && l.pct <= pending.tier.pct)

/** Training day of a workout, re-exported here so callers building layoff
 *  records don't have to reach into `schedule` for one helper. */
export const workoutDay = (workout: WorkoutRecord, config: ProgramConfig): string =>
  trainingDay(workout.date, config.dayRolloverHour)
