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
 *
 * The loop NEVER stops once started, and that is a deliberate simplification of
 * an earlier design that halted it on a lost folder permission. Halting was
 * solving a problem that did not exist: the requirement is that a lost
 * permission is asked about ONCE rather than on every idle tick, and a tick
 * cannot ask at all — it calls `queryPermission`, which never prompts, and only
 * the settings surface ever calls `requestPermission`. What halting did cost was
 * real: every tab that met the lost permission stopped independently, so a
 * re-grant in one tab left the others halted while displaying a healthy mirror,
 * and reviving them needed a cross-tab wake-up that a running loop does not.
 * A permission-lost run now just takes the ordinary cadence and recovers by
 * itself in every tab.
 */
import type {Repo} from '@/data/repo'
import {dbFilenameForUser} from '@/data/localDbStorage.js'
import type {AppEffect} from '@/extensions/core.js'
import {cadencedIdleJob, type CadencedIdleJob} from '@/utils/cadencedIdleJob.js'
import {LAZY_DEEP_IDLE} from '@/utils/scheduleIdle.js'
import {readDatabaseIncarnation} from './changeMarker.js'
import {runDbMirror, type DbMirrorOutcome} from './mirror.js'
import {withMirrorRunLock} from './runLock.js'
import {supportsDirectoryMirroring} from './fileSystemAccess.js'
import {DB_MIRROR_DEFAULTS, dbMirrorStore, type DbMirrorStore} from './store.js'

/** A run that threw. Short enough that a transient failure (the folder's drive
 *  briefly unmounted) doesn't cost a whole cadence. */
export const FAILURE_RETRY_MS = 5 * 60_000

/** Another tab held the run lock. It may be mid-copy — or it may have crashed,
 *  closed, or failed — so this comes back well before the full cadence, which
 *  on a weekly setting would otherwise leave the survivor idle for days. */
export const BUSY_RETRY_MS = 5 * 60_000

export const PERMISSION_LOST_MESSAGE =
  'This browser no longer has permission to write to the chosen folder, so no copies are ' +
  'being made. Open the mirror settings to grant it again.'

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
  /** Bring the running loop's next run forward. For the settings surface, where
   *  a change the user just made — enabling it, a new folder, a shorter
   *  interval — should not wait out a delay chosen before it existed. A no-op
   *  when no effect is running. */
  resume: (delayMs?: number) => void
}

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

/** Best effort, like pruning. A status write is bookkeeping ABOUT the run: it
 *  must not turn a finished copy into a failure, and on the error path it must
 *  not replace the error the caller is about to see with its own. A dropped
 *  write costs one redundant copy next run, since the marker went unrecorded —
 *  the safe direction. */
const recordStatusQuietly = async (
  store: DbMirrorStore,
  userId: string,
  patch: Parameters<DbMirrorStore['recordStatus']>[1],
): Promise<void> => {
  try {
    await store.recordStatus(userId, patch)
  } catch (err) {
    console.warn('[db-mirror] could not record the run status', err)
  }
}

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

  const recordStatus = (
    userId: string,
    patch: Parameters<DbMirrorStore['recordStatus']>[1],
  ): Promise<void> => recordStatusQuietly(store, userId, patch)

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
    // A status recorded against a DIFFERENT database says nothing about this
    // one — an import replaced it, or the browser wiped the local store and the
    // app rebuilt it. Withholding `lastCopy` there is what stops a fresh
    // database inheriting the old one's marker and deciding it has nothing to
    // copy.
    const incarnation = await readDatabaseIncarnation(repo)
    const describesThisDatabase =
      incarnation !== undefined && state.status.incarnation === incarnation

    try {
      const outcome = await withRunLock(dbFilenameForUser(userId), () => mirror({
        repo,
        directory,
        keepCount: state.settings.keepCount,
        now: at,
        lastCopy:
          describesThisDatabase && state.status.lastMarker && state.status.lastFilename
            ? {marker: state.status.lastMarker, filename: state.status.lastFilename}
            : undefined,
      }))
      // Another tab holds the run lock. Nothing to record: that tab is
      // recording its own run into the same storage.
      if (outcome === null) return {outcome: {kind: 'busy-elsewhere'}, intervalMs}
      switch (outcome.kind) {
        case 'mirrored':
          await recordStatus(userId, {
            incarnation,
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
          // Reaching here means the permission held and the folder was read, so
          // any recorded failure describes a state that is over — leaving it
          // would have the chip report a paused mirror that is running fine.
          await recordStatus(userId, {
            lastCheckedAt: at,
            permissionLost: false,
            lastError: undefined,
            lastErrorAt: undefined,
          })
          break
        case 'permission-lost':
          await recordStatus(userId, {
            permissionLost: true,
            lastCheckedAt: at,
            lastError: PERMISSION_LOST_MESSAGE,
            lastErrorAt: at,
          })
          break
      }
      return {outcome, intervalMs}
    } catch (err) {
      await recordStatus(userId, {
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

  /** How long before the next scheduled run, given what this one found. */
  const delayFor = (report: DbMirrorRunReport): number =>
    report.outcome.kind === 'busy-elsewhere'
      ? Math.min(BUSY_RETRY_MS, report.intervalMs)
      : report.intervalMs

  const effect: AppEffect = {
    id: 'db-mirror.schedule',
    start: ({repo}) => {
      // No picker, no feature: there is no way for the user to have chosen a
      // folder, and nothing to re-check later in the same session.
      if (!supported()) return

      // Publish the persisted state at once. Until something loads it the
      // snapshot is null and the health chip has nothing to show, so a
      // permission or disk failure recorded in a previous session would stay
      // invisible until the first scheduled run — which waits for a genuinely
      // idle main thread and may never come in a busy session.
      store.load(repo.user.id).catch((err: unknown) => {
        console.warn('[db-mirror] could not read the mirror state at startup', err)
      })

      const loop = job.start(
        async () => delayFor(await performDbMirror(repo)),
        {onFailureDelayMs: FAILURE_RETRY_MS},
      )
      const mine = {resume: (delayMs: number) => loop.rearmIn(delayMs)}
      live = mine

      // The settings surface re-arms the tab it runs in; the store's broadcast
      // is what carries the change to the others. Only a changed INTERVAL
      // re-arms — every status write publishes too, and re-arming on those
      // would restart the cadence continuously and starve the copy.
      // The FIRST reading is a baseline, not a change: the loop has just been
      // armed on the job's own short first delay, and re-arming it to the full
      // interval here would push a fresh session's first copy a whole cadence
      // out.
      let armedFor = store.getSnapshot()?.settings.intervalMinutes
      const stopWatching = store.subscribe(() => {
        const minutes = store.getSnapshot()?.settings.intervalMinutes
        if (minutes === undefined || minutes === armedFor) return
        const baseline = armedFor === undefined
        armedFor = minutes
        if (!baseline) loop.rearmIn(minutes * 60_000)
      })

      return () => {
        stopWatching()
        // Only if it is still ours — a restart for another user may already have
        // replaced it.
        if (live === mine) live = null
        loop.stop()
      }
    },
  }

  return {
    effect,
    resume: (delayMs = 0) => live?.resume(delayMs),
    runNow: async (repo) => {
      // Captured before the await: the effect can restart for a different user
      // while a large copy is in flight, and this run's cadence must not
      // reschedule the loop that replaced it.
      const started = live
      const rearm = (delayMs: number): void => {
        if (started && started === live) started.resume(delayMs)
      }
      try {
        const report = await performDbMirror(repo)
        rearm(delayFor(report))
        return report
      } catch (err) {
        // A scheduled run that throws gets `onFailureDelayMs` from the job; a
        // manual one has no such backstop, so without this the automatic retry
        // stays on a timer chosen before the failure — up to a week away.
        rearm(FAILURE_RETRY_MS)
        throw err
      }
    },
  }
}

export const dbMirrorSchedule = createDbMirrorSchedule()
export const dbMirrorEffect = dbMirrorSchedule.effect
