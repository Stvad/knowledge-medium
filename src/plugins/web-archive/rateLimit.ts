/**
 * Submission volume: how much has been published, and may we publish more.
 *
 * The counts are DERIVED from the records themselves — every submission is a
 * block carrying `webarchive:submittedAt`, so "how many in the last hour" is
 * a fold over those, not a counter someone has to remember to increment. A
 * counter would drift on a crash mid-submit, would be clobbered by a
 * concurrent write from another device, and would disagree with the records
 * the user can see. This can't.
 */

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS

export interface VolumeStats {
  /** Every URL ever published from this workspace. */
  readonly total: number
  readonly lastHour: number
  readonly lastDay: number
  /** Recorded but not yet published — the backlog. */
  readonly pending: number
  /** Published, awaiting a verified snapshot URL. */
  readonly awaitingSnapshot: number
  readonly failed: number
}

export interface VolumeInput {
  readonly submittedAt: Date | undefined
  readonly status: string
}

export const computeVolume = (
  records: readonly VolumeInput[],
  now: Date,
): VolumeStats => {
  const nowMs = now.getTime()
  let total = 0
  let lastHour = 0
  let lastDay = 0
  let pending = 0
  let awaitingSnapshot = 0
  let failed = 0

  for (const record of records) {
    if (record.status === 'pending') pending += 1
    if (record.status === 'submitted') awaitingSnapshot += 1
    if (record.status === 'failed') failed += 1

    const submitted = record.submittedAt?.getTime()
    if (submitted === undefined || Number.isNaN(submitted)) continue
    total += 1
    // A future timestamp (clock skew between devices) counts toward the
    // window rather than being ignored: over-counting throttles us, which is
    // the safe direction.
    const age = nowMs - submitted
    if (age <= HOUR_MS) lastHour += 1
    if (age <= DAY_MS) lastDay += 1
  }

  return {total, lastHour, lastDay, pending, awaitingSnapshot, failed}
}

export interface RateLimits {
  readonly hourlyLimit: number
  readonly dailyLimit: number
}

export interface Budget {
  /** How many more submissions are allowed right now. */
  readonly remaining: number
  /** Which limit is binding, when `remaining` is 0. */
  readonly blockedBy: 'hourly' | 'daily' | undefined
}

/** A non-positive limit means "never submit" — an explicit off switch a user
 *  can reach without hunting for the enable toggle. */
export const submissionBudget = (
  stats: Pick<VolumeStats, 'lastHour' | 'lastDay'>,
  limits: RateLimits,
): Budget => {
  const hourlyRoom = Math.max(0, Math.floor(limits.hourlyLimit) - stats.lastHour)
  const dailyRoom = Math.max(0, Math.floor(limits.dailyLimit) - stats.lastDay)
  const remaining = Math.min(hourlyRoom, dailyRoom)
  if (remaining > 0) return {remaining, blockedBy: undefined}
  return {remaining: 0, blockedBy: hourlyRoom <= dailyRoom ? 'hourly' : 'daily'}
}

// ──── Backoff ────

/** Give up after this many network attempts on one record. */
export const MAX_ATTEMPTS = 6

/** Minimum gap between two submissions, independent of the hourly ceiling.
 *  The ceiling controls volume; this controls burst — a paste of forty links
 *  shouldn't arrive at the archive as forty simultaneous requests. */
export const MIN_SUBMIT_GAP_MS = 5_000

const BASE_BACKOFF_MS = 60_000

/** Exponential, capped at an hour. Attempt 1 waits a minute, attempt 5 waits
 *  16, and nothing waits longer than an hour so a transient outage doesn't
 *  strand a record for a day. */
export const backoffMs = (attempts: number): number =>
  Math.min(BASE_BACKOFF_MS * 4 ** Math.max(0, attempts - 1), HOUR_MS)

export interface AttemptInput {
  readonly attempts: number
  readonly lastAttemptAt: Date | undefined
}

export const isAttemptDue = (record: AttemptInput, now: Date): boolean => {
  if (record.attempts <= 0 || !record.lastAttemptAt) return true
  const elapsed = now.getTime() - record.lastAttemptAt.getTime()
  // Negative elapsed = the last attempt is stamped in the future (clock skew
  // from another device). Treat it as not due; the alternative is a hot loop.
  return elapsed >= backoffMs(record.attempts)
}
