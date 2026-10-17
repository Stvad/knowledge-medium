/**
 * The drain loop: the only place in this plugin that reaches the network.
 *
 * One tick does as little as the budget allows and stops. It never bursts:
 * submissions are spaced by `MIN_SUBMIT_GAP_MS`, capped by the user's rolling
 * hour/day ceilings, and each record backs off exponentially on failure. When
 * the ceiling is reached the backlog simply waits — nothing is dropped, and
 * the pending records stay visible in the outline.
 */

import type { Repo } from '@/data/repo'
import { appEffectsFacet, type AppEffect } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { LAZY_DEEP_IDLE, scheduleDeepIdle } from '@/utils/scheduleIdle.js'
import { showInfo } from '@/utils/toast.js'
import type { WebArchivePrefs } from './prefs.ts'
import { loadPrefs } from './prefs.ts'
import {
  computeVolume,
  DAY_MS,
  isAttemptDue,
  MAX_ATTEMPTS,
  MIN_SUBMIT_GAP_MS,
  submissionBudget,
  type VolumeStats,
} from './rateLimit.ts'
import type { ArchiveService } from './service.ts'
import { resolveArchiveService } from './serviceRegistry.ts'
import {
  queryOpenRecords,
  querySubmittedSince,
  updateRecord,
  type ArchiveRecord,
} from './snapshots.ts'

export const DRAIN_INTERVAL_MS = 60_000

/** Records touched per tick, before the rate budget is even consulted. Keeps
 *  one tick's worth of work bounded regardless of backlog size. */
const MAX_PER_TICK = 5

export interface DrainDeps {
  readonly repo: Repo
  readonly workspaceId: string
  readonly now: () => Date
  readonly sleep: (ms: number) => Promise<void>
  readonly isOnline: () => boolean
  readonly notify: (message: string) => void
}

export interface DrainOutcome {
  readonly submitted: number
  readonly resolved: number
  readonly failed: number
  /** True whenever a queued URL was held back by a rate ceiling. Reported
   *  independently of `skippedReason` because the tick can do read-back work
   *  while submissions are blocked — folding the two together hid the ceiling
   *  from the caller in exactly that case. */
  readonly rateLimited: boolean
  /** Set only when the tick did nothing at all. */
  readonly skippedReason?:
    | 'disabled'
    | 'offline'
    | 'no-service'
    | 'rate-limited'
    | 'nothing-due'
}

const EMPTY = {submitted: 0, resolved: 0, failed: 0, rateLimited: false} as const

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Last hour-bucket warned about, per workspace. A Map keyed by workspace
 *  (rather than a Set of every bucket ever seen) so a long-lived tab doesn't
 *  accumulate one entry per hour for the life of the session. */
const lastNotifiedBucket = new Map<string, number>()

export const resetVolumeNotifications = (): void => {
  lastNotifiedBucket.clear()
}

export const maybeNotifyVolume = (
  workspaceId: string,
  stats: Pick<VolumeStats, 'lastHour'>,
  prefs: WebArchivePrefs,
  now: Date,
  notify: (message: string) => void,
): boolean => {
  if (prefs.notifyThreshold <= 0) return false
  if (stats.lastHour < prefs.notifyThreshold) return false
  const bucket = Math.floor(now.getTime() / (60 * 60 * 1000))
  if (lastNotifiedBucket.get(workspaceId) === bucket) return false
  lastNotifiedBucket.set(workspaceId, bucket)
  notify(
    `Web archive: ${stats.lastHour} URLs submitted in the last hour. ` +
    'Each one is now public.',
  )
  return true
}

const submitOne = async (
  deps: DrainDeps,
  service: ArchiveService,
  record: ArchiveRecord,
): Promise<'submitted' | 'failed'> => {
  const attempts = record.attempts + 1
  const attemptedAt = deps.now()
  try {
    const result = await service.submit(record.url)
    if (!result.accepted) throw new Error('service did not accept the request')
    await updateRecord(deps.repo, record, {
      // A service that hands back a snapshot URL synchronously has told us
      // where the copy is; anything else is only "sent".
      status: result.archiveUrl ? 'archived' : 'submitted',
      attempts,
      lastAttemptAt: attemptedAt,
      submittedAt: attemptedAt,
      ...(result.archiveUrl ? {archiveUrl: result.archiveUrl} : {}),
    })
    return 'submitted'
  } catch (error) {
    await updateRecord(deps.repo, record, {
      status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
      attempts,
      lastAttemptAt: attemptedAt,
      error: errorMessage(error),
    })
    return 'failed'
  }
}

const resolveOne = async (
  deps: DrainDeps,
  service: ArchiveService,
  record: ArchiveRecord,
): Promise<'resolved' | 'pending' | 'failed'> => {
  const attempts = record.attempts + 1
  const attemptedAt = deps.now()
  // `submittedAt` is what the archived copy must be at-or-after. It is always
  // set by the time a record reaches `submitted`; fall back to the attempt
  // clock rather than accepting any historical snapshot.
  const notBefore = record.submittedAt ?? attemptedAt
  try {
    const archiveUrl = await service.resolve(record.url, notBefore)
    if (!archiveUrl) {
      await updateRecord(deps.repo, record, {
        status: attempts >= MAX_ATTEMPTS ? 'failed' : 'submitted',
        attempts,
        lastAttemptAt: attemptedAt,
        ...(attempts >= MAX_ATTEMPTS
          ? {error: 'no archived copy appeared before giving up'}
          : {}),
      })
      return attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
    }
    await updateRecord(deps.repo, record, {
      status: 'archived',
      attempts,
      lastAttemptAt: attemptedAt,
      archiveUrl,
    })
    return 'resolved'
  } catch (error) {
    await updateRecord(deps.repo, record, {
      status: attempts >= MAX_ATTEMPTS ? 'failed' : 'submitted',
      attempts,
      lastAttemptAt: attemptedAt,
      error: errorMessage(error),
    })
    return attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
  }
}

/**
 * One pass. Returns what it did so tests can assert on behaviour rather than
 * on wall-clock timing.
 */
export const drainOnce = async (deps: DrainDeps): Promise<DrainOutcome> => {
  const prefs = await loadPrefs(deps.repo, deps.workspaceId)
  if (!prefs.enabled) return {...EMPTY, skippedReason: 'disabled'}
  if (!deps.isOnline()) return {...EMPTY, skippedReason: 'offline'}

  const service = resolveArchiveService(deps.repo, prefs.serviceId)
  if (!service) return {...EMPTY, skippedReason: 'no-service'}

  const now = deps.now()
  // Two narrow reads instead of the whole archive: the records that still
  // need work, and the ones that count against the rolling ceilings. Feeding
  // `computeVolume` only the last day's submissions makes its window counts
  // exact and its all-time `total` meaningless — which is why nothing here
  // reads `total`, and the settings panel does its own full query for it.
  const open = await queryOpenRecords(deps.repo, deps.workspaceId)
  const recent = await querySubmittedSince(
    deps.repo,
    deps.workspaceId,
    new Date(now.getTime() - DAY_MS),
  )
  const stats = computeVolume(recent, now)
  maybeNotifyVolume(deps.workspaceId, stats, prefs, now, deps.notify)

  // Read-backs are cheap GETs against a different endpoint and publish
  // nothing new, so they are not charged against the submission budget.
  const due = open.filter(record => isAttemptDue(record, now))
  const toResolve = due
    .filter(record => record.status === 'submitted' && record.serviceId === service.id)
    .slice(0, MAX_PER_TICK)

  const budget = submissionBudget(stats, prefs)
  const submittable = due
    .filter(record => record.status === 'pending' && record.serviceId === service.id)
  const toSubmit = submittable.slice(0, Math.min(MAX_PER_TICK, budget.remaining))
  // Only the BUDGET counts as rate-limited. `MAX_PER_TICK` also trims the
  // batch, but that backlog clears on the next tick a minute later; conflating
  // the two would report a ceiling the user never hit.
  const rateLimited = budget.remaining < submittable.length

  if (toResolve.length === 0 && toSubmit.length === 0) {
    return {
      ...EMPTY,
      rateLimited,
      skippedReason: rateLimited ? 'rate-limited' : 'nothing-due',
    }
  }

  let resolved = 0
  let failed = 0
  for (const record of toResolve) {
    const outcome = await resolveOne(deps, service, record)
    if (outcome === 'resolved') resolved += 1
    if (outcome === 'failed') failed += 1
  }

  let submitted = 0
  for (const [index, record] of toSubmit.entries()) {
    // Space out submissions. The hourly ceiling bounds volume; this bounds
    // burst, so a forty-link paste doesn't arrive as forty parallel requests.
    if (index > 0) await deps.sleep(MIN_SUBMIT_GAP_MS)
    const outcome = await submitOne(deps, service, record)
    if (outcome === 'submitted') submitted += 1
    else failed += 1
  }

  return {submitted, resolved, failed, rateLimited}
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, ms) })

export const webArchiveDrainEffect: AppEffect = {
  id: 'web-archive.drain',
  start: ({repo, workspaceId}) => {
    let disposed = false
    let running = false

    const deps: DrainDeps = {
      repo,
      workspaceId,
      now: () => new Date(),
      sleep,
      // `navigator.onLine` is a weak signal (true on a captive portal) but a
      // reliable NEGATIVE one — false means don't bother.
      isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
      notify: message => showInfo(message, {duration: 10_000}),
    }

    const tick = async () => {
      // A tick can outlive its interval (network waits + the inter-submit
      // gap); overlapping runs would double-submit the same record.
      if (disposed || running) return
      running = true
      try {
        await drainOnce(deps)
      } catch (error) {
        console.warn('[web-archive] drain tick failed', error)
      } finally {
        running = false
      }
    }

    // Nothing here is urgent, and the first tick must not compete with
    // startup — defer it to genuine idle.
    scheduleDeepIdle(() => { void tick() }, LAZY_DEEP_IDLE)
    const timer = setInterval(() => { void tick() }, DRAIN_INTERVAL_MS)

    return () => {
      disposed = true
      clearInterval(timer)
    }
  },
}

export const webArchiveDrainExtension: AppExtension =
  appEffectsFacet.of(webArchiveDrainEffect, {source: 'web-archive'})
