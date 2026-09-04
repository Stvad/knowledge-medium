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
  | DbMirrorOutcome

export interface DbMirrorRunReport {
  outcome: DbMirrorTickResult
  /** Wall clock the loop should wait before the next run. */
  intervalMs: number
}

export interface DbMirrorScheduleDeps {
  store?: DbMirrorStore
  mirror?: typeof runDbMirror
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

  const performDbMirror = async (repo: Repo): Promise<DbMirrorRunReport> => {
    const userId = repo.user.id
    // Read storage, not a cached snapshot: the settings surface writes between
    // runs, and a second tab writes the same records.
    const state = await store.load(userId)
    const intervalMs = state.settings.intervalMinutes * 60_000
    if (!state.settings.enabled) return {outcome: {kind: 'disabled'}, intervalMs}
    if (!state.directory) return {outcome: {kind: 'no-folder'}, intervalMs}

    try {
      const outcome = await mirror({
        repo,
        directory: state.directory,
        keepCount: state.settings.keepCount,
        now: now(),
        lastMarker: state.status.lastMarker,
      })
      if (outcome.kind === 'mirrored') {
        await store.recordStatus(userId, {
          lastMarker: outcome.marker,
          lastMirrorAt: now(),
          lastCheckedAt: now(),
          lastFilename: outcome.filename,
          lastBytes: outcome.bytes,
          permissionLost: false,
          lastError: undefined,
          lastErrorAt: undefined,
        })
      } else if (outcome.kind === 'skipped-unchanged') {
        await store.recordStatus(userId, {lastCheckedAt: now()})
      } else {
        await store.recordStatus(userId, {
          permissionLost: true,
          lastCheckedAt: now(),
          lastError: PERMISSION_LOST_MESSAGE,
          lastErrorAt: now(),
        })
      }
      return {outcome, intervalMs}
    } catch (err) {
      await store.recordStatus(userId, {
        lastCheckedAt: now(),
        lastError: describeError(err),
        lastErrorAt: now(),
      })
      // Rethrown so the job logs it and takes `onFailureDelayMs` rather than
      // the full cadence; the status above is what the user sees.
      throw err
    }
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
