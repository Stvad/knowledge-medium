/*
 * When the mirror runs.
 *
 * A cadenced idle job, not a timer: copying gigabytes is exactly the work that
 * must not land mid-load, and `cadencedIdleJob` waits out a wall-clock floor
 * and then a genuinely free main thread. The cadence itself comes back from
 * each run, so the user's interval setting takes effect on the next tick
 * instead of at the next reload.
 *
 * One entry point — `runNow` (the settings surface's "Mirror now") and the
 * scheduled tick both go through `performDbMirror`, so a manual run cannot skip
 * a check the scheduled one makes, or record its result differently.
 */
import type {Repo} from '@/data/repo'
import type {AppEffect} from '@/extensions/core.js'
import {cadencedIdleJob, type CadencedIdleJob, type LoopHandle} from '@/utils/cadencedIdleJob.js'
import {LAZY_DEEP_IDLE} from '@/utils/scheduleIdle.js'
import {runDbMirror, type DbMirrorOutcome} from './mirror.js'
import {withMirrorRunLock} from './runLock.js'
import {supportsDirectoryMirroring} from './fileSystemAccess.js'
import {DB_MIRROR_DEFAULTS, dbMirrorStore, type DbMirrorStore} from './store.js'

/** A run that threw. Short enough that a transient failure (the folder's drive
 *  briefly unmounted) doesn't cost a whole cadence. */
export const FAILURE_RETRY_MS = 5 * 60_000

export const PERMISSION_LOST_MESSAGE =
  'This browser no longer has permission to write to the chosen folder. Open the mirror ' +
  'settings to grant it again — mirroring is paused until you do.'

export type DbMirrorTickResult =
  | {kind: 'disabled'}
  | {kind: 'no-folder'}
  /** Another tab of the app is mirroring right now. */
  | {kind: 'busy-elsewhere'}
  | DbMirrorOutcome

export interface DbMirrorRunReport {
  outcome: DbMirrorTickResult
  /** Wall clock the loop should wait before the next run. */
  intervalMs: number
}

export interface DbMirrorScheduleDeps {
  store?: DbMirrorStore
  mirror?: typeof runDbMirror
  withRunLock?: typeof withMirrorRunLock
  job?: CadencedIdleJob
  supported?: () => boolean
  now?: () => number
}

export interface DbMirrorSchedule {
  effect: AppEffect
  /** Run once, now, from a user gesture. Re-arms the loop from this run. */
  runNow: (repo: Repo) => Promise<DbMirrorRunReport>
  /** Re-arm the running loop, restarting it if a lost permission stopped it.
   *  For the settings surface: a changed setting or a fresh grant. */
  resume: (delayMs?: number) => void
}

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

export const createDbMirrorSchedule = ({
  store = dbMirrorStore,
  mirror = runDbMirror,
  withRunLock = withMirrorRunLock,
  job = cadencedIdleJob({
    firstDelayMs: LAZY_DEEP_IDLE.minDelayMs,
    repeatDelayMs: DB_MIRROR_DEFAULTS.intervalMinutes * 60_000,
    label: 'db-mirror',
  }),
  supported = supportsDirectoryMirroring,
  now = Date.now,
}: DbMirrorScheduleDeps = {}): DbMirrorSchedule => {
  /** The running effect's controls, or null while no effect is started. */
  let live: {resume: (delayMs: number) => void} | null = null
  /** ONE copy at a time IN THIS TAB. The loop cannot overlap itself, but
   *  "Mirror now" can land in the middle of a scheduled run, so a second caller
   *  joins the run already going. Keyed by user: signing out in local-only mode
   *  swaps the repo without a reload, and joining across that would hand the new
   *  user the previous one's report for a copy of a database that is no longer
   *  theirs. Other TABS are excluded by `withMirrorRunLock`. */
  let inFlight: {userId: string; run: Promise<DbMirrorRunReport>} | null = null

  const mirrorOnce = async (repo: Repo): Promise<DbMirrorRunReport> => {
    const userId = repo.user.id
    // Read storage, not a cached snapshot: the settings surface writes between
    // runs, and a second tab writes the same records.
    const state = await store.load(userId)
    const intervalMs = state.settings.intervalMinutes * 60_000
    if (!state.settings.enabled) return {outcome: {kind: 'disabled'}, intervalMs}
    const directory = state.directory
    if (!directory) return {outcome: {kind: 'no-folder'}, intervalMs}

    // One reading for the whole run, so "checked" and "mirrored" can't come
    // out a millisecond apart on the same copy.
    //
    // ACCEPTED, not guarded: changing the folder while a copy is in flight
    // leaves this run recording the previous folder's filename against the new
    // one. It costs a wrong line of status until the next run, and nothing
    // more — the skip verifies the named copy is in the folder it is looking
    // at, so a stale record makes the next run COPY rather than skip.
    const at = now()
    try {
      const outcome = await withRunLock(() => mirror({
        repo,
        directory,
        keepCount: state.settings.keepCount,
        now: at,
        lastCopy:
          state.status.lastMarker && state.status.lastFilename
            ? {marker: state.status.lastMarker, filename: state.status.lastFilename}
            : undefined,
      }))
      // Another tab holds the run lock. Nothing to record: that tab is
      // recording its own run into the same storage.
      if (outcome === null) return {outcome: {kind: 'busy-elsewhere'}, intervalMs}
      switch (outcome.kind) {
        case 'mirrored':
          await store.recordStatus(userId, {
            lastMarker: outcome.marker,
            lastMirrorAt: at,
            lastCheckedAt: at,
            lastFilename: outcome.filename,
            lastBytes: outcome.bytes,
            permissionLost: false,
            lastError: undefined,
            lastErrorAt: undefined,
          })
          break
        case 'skipped-unchanged':
          await store.recordStatus(userId, {lastCheckedAt: at})
          break
        case 'permission-lost':
          await store.recordStatus(userId, {
            permissionLost: true,
            lastCheckedAt: at,
            lastError: PERMISSION_LOST_MESSAGE,
            lastErrorAt: at,
          })
          break
      }
      return {outcome, intervalMs}
    } catch (err) {
      await store.recordStatus(userId, {
        lastCheckedAt: at,
        lastError: describeError(err),
        lastErrorAt: at,
      })
      // Rethrown so the job logs it and takes `onFailureDelayMs` rather than
      // the full cadence; the status above is what the user sees.
      throw err
    }
  }

  const performDbMirror = (repo: Repo): Promise<DbMirrorRunReport> => {
    if (inFlight?.userId === repo.user.id) return inFlight.run
    const entry = {userId: repo.user.id} as {userId: string; run: Promise<DbMirrorRunReport>}
    entry.run = (async () => {
      try {
        return await mirrorOnce(repo)
      } finally {
        // Only if it is still OURS: a run for a different user may have
        // replaced it while this one was in flight.
        if (inFlight === entry) inFlight = null
      }
    })()
    inFlight = entry
    return entry.run
  }

  const effect: AppEffect = {
    id: 'db-mirror.schedule',
    start: ({repo}) => {
      // No picker, no feature: there is no way for the user to have chosen a
      // folder, and nothing to re-check later in the same session.
      if (!supported()) return
      let loop: LoopHandle | null = null
      let disposed = false

      const halt = (): void => {
        loop?.stop()
        loop = null
      }
      const arm = (delayMs?: number): void => {
        if (disposed) return
        if (!loop) loop = job.start(tick, {onFailureDelayMs: FAILURE_RETRY_MS})
        if (delayMs !== undefined) loop.rearmIn(delayMs)
      }

      async function tick(): Promise<number | void> {
        const {outcome, intervalMs} = await performDbMirror(repo)
        if (outcome.kind === 'permission-lost') {
          // Stop, rather than retry on a cadence. Only `requestPermission` from
          // a user gesture can restore the grant and a tick has none, so every
          // further run would fail identically. The settings surface asks once
          // and calls `resume`.
          halt()
          return
        }
        return intervalMs
      }

      arm()
      live = {resume: arm}
      return () => {
        disposed = true
        live = null
        halt()
      }
    },
  }

  return {
    effect,
    resume: (delayMs = 0) => live?.resume(delayMs),
    runNow: async (repo) => {
      const report = await performDbMirror(repo)
      // Measure the next scheduled run from this one, and restart a loop that a
      // lost permission had stopped — the run just proved the grant is back.
      if (report.outcome.kind !== 'permission-lost') live?.resume(report.intervalMs)
      return report
    },
  }
}

export const dbMirrorSchedule = createDbMirrorSchedule()
export const dbMirrorEffect = dbMirrorSchedule.effect
