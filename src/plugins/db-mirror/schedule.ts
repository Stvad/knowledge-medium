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
 * The loop NEVER stops once started. Halting it on a lost folder permission was
 * considered and rejected: a tick only calls `queryPermission`, which never
 * prompts, so halting buys nothing — and it strands every other tab after a
 * re-grant made in one of them.
 */
import type {Repo} from '@/data/repo'
import {dbFilenameForUser} from '@/data/localDbStorage.js'
import type {AppEffect} from '@/extensions/core.js'
import {cadencedIdleJob, type CadencedIdleJob, type LoopHandle} from '@/utils/cadencedIdleJob.js'
import {LAZY_DEEP_IDLE} from '@/utils/scheduleIdle.js'
import {readDatabaseIncarnation} from './changeMarker.js'
import {runDbMirror, type DbMirrorOutcome} from './mirror.js'
import {dbMirrorRuntimeHealth} from './runtimeHealth.js'
import {withMirrorRunLock} from './runLock.js'
import {supportsDirectoryMirroring} from './fileSystemAccess.js'
import {DB_MIRROR_DEFAULTS, dbMirrorStore, type DbMirrorStore} from './store.js'

/** The FIRST retry after a run that threw. Short enough that a transient
 *  failure — the folder's drive briefly unmounted — doesn't cost a whole
 *  cadence. Each further consecutive failure doubles it; see
 *  {@link failureDelay}. */
export const FAILURE_RETRY_MS = 5 * 60_000

/**
 * How long to wait after `consecutive` failures in a row.
 *
 * Doubling, capped at the user's own interval. A flat retry is right for a
 * transient failure and badly wrong for a permanent one: a destination that
 * cannot finish inside the export's deadline fails after holding PowerSync's
 * write lock for its full three minutes, and at a fixed five-minute retry that
 * is well over a third of the session spent with every write blocked, forever.
 * Capping at the interval means a mirror that never succeeds costs no more
 * than one that always does.
 */
export const failureDelay = (consecutive: number, intervalMs: number): number =>
  Math.min(intervalMs, FAILURE_RETRY_MS * 2 ** Math.min(Math.max(consecutive, 1) - 1, 10))

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
  /** A run on this device already covered this interval. */
  | {kind: 'too-soon'; dueInMs: number}
  /** The database could not say which database it is, so nothing was written. */
  | {kind: 'no-identity'}
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

  /** The interval this schedule last actually READ, for the failure path —
   *  which has no report to take one from, and must not go back to storage that
   *  may be what failed. Remembered rather than re-derived from the snapshot,
   *  because the snapshot is null in exactly the case this exists for, and the
   *  default it fell back to could be longer than the interval the user chose. */
  let lastKnownIntervalMs = DB_MIRROR_DEFAULTS.intervalMinutes * 60_000

  const recordStatus = (
    userId: string,
    patch: Parameters<DbMirrorStore['recordStatus']>[1],
  ): Promise<void> => recordStatusQuietly(store, userId, patch)

  /**
   * @param force take the copy even if a run already covered this interval.
   *   For "Mirror now", where the user is asking for a copy rather than for
   *   the cadence to be honoured.
   */
  const mirrorOnce = async (repo: Repo, force: boolean): Promise<DbMirrorRunReport> => {
    const userId = repo.user.id
    // Read storage, not a cached snapshot: the settings surface writes between
    // runs, and a second tab writes the same records.
    const state = await store.load(userId)
    const intervalMs = state.settings.intervalMinutes * 60_000
    lastKnownIntervalMs = intervalMs
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
    // Every path that turns mirroring on is a persisting write, and those mint
    // the install id — so reaching here without one means a half-written
    // record. Minting it now rather than carrying an "install unknown" state
    // through the run is what keeps ownership decidable: a copy whose install
    // group we do not recognise is a copy nothing can ever reclaim.
    const installId = state.installId ?? (await store.recordStatus(userId, {})).installId
    // Unreachable through the real store, which mints on every persisting
    // write; this is the narrowing, and a loud answer for an injected store
    // that does not.
    if (installId === undefined) {
      throw new Error('The mirror could not establish an id for this install, so no copy was taken.')
    }
    // A status recorded against a DIFFERENT database says nothing about this
    // one — an import replaced it, or the browser wiped the local store and the
    // app rebuilt it. Withholding `lastCopy` there is what stops a fresh
    // database inheriting the old one's marker and deciding it has nothing to
    // copy.
    const incarnation = await readDatabaseIncarnation(repo)
    // No copy at all rather than one under a stand-in identity. A copy nothing
    // can place among the others is worse than a missing one: the pruner would
    // eventually rank it against copies of a different database. The two ways
    // to get here both argue for waiting — an empty log means no local writes
    // yet, so there is nothing this feature protects, and an unreadable log on
    // a database we are about to checkpoint and copy under a write lock is not
    // a database the copy was likely to succeed against either.
    if (incarnation === undefined) return {outcome: {kind: 'no-identity'}, intervalMs}
    const describesThisDatabase = state.status.incarnation === incarnation

    // The interval belongs to the DEVICE, not to this tab's timer. Every tab
    // runs its own loop against the same folder, so without this each one takes
    // its own full copy per interval: N tabs meant N copies, N holds of
    // PowerSync's write lock, and a keep count that spanned 1/N of the history
    // the user asked for. The winner of the run lock records `lastCheckedAt`,
    // and this is where the others read it.
    //
    // Only for a status that describes THIS database — one recorded before an
    // import or a wipe says nothing about the copy that is due now — and only
    // forwards, so a clock that jumped backwards defers nothing.
    const sinceLastRun =
      describesThisDatabase && state.status.lastCheckedAt !== undefined
        ? at - state.status.lastCheckedAt
        : undefined
    if (!force && sinceLastRun !== undefined && sinceLastRun >= 0 && sinceLastRun < intervalMs) {
      return {outcome: {kind: 'too-soon', dueInMs: intervalMs - sinceLastRun}, intervalMs}
    }

    try {
      const outcome = await withRunLock(dbFilenameForUser(userId), () => mirror({
        repo,
        directory,
        keepCount: state.settings.keepCount,
        now: at,
        installId,
        incarnation,
        lastCopy:
          describesThisDatabase && state.status.lastMarker && state.status.lastFilename
            ? {
                marker: state.status.lastMarker,
                filename: state.status.lastFilename,
                bytes: state.status.lastBytes,
              }
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
            unmanagedCopies: outcome.unmanaged,
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
            unmanagedCopies: outcome.unmanaged,
            permissionLost: false,
            lastError: undefined,
            lastErrorAt: undefined,
          })
          break
        case 'permission-lost':
          await recordStatus(userId, {
            permissionLost: true,
            lastError: PERMISSION_LOST_MESSAGE,
            lastErrorAt: at,
          })
          break
      }
      return {outcome, intervalMs}
    } catch (err) {
      await recordStatus(userId, {
        // The permission check happens before the copy and returns rather than
        // throwing, so a throw here is some OTHER failure — a full disk, a
        // vanished drive. Leaving a stale permission flag set would have the
        // chip offer "Grant access again" for a problem that is nothing of the
        // sort; if the grant really is gone, the next run records it again.
        permissionLost: false,
        lastError: describeError(err),
        lastErrorAt: at,
      })
      // Rethrown so the job logs it and takes `onFailureDelayMs` rather than
      // the full cadence; the status above is what the user sees.
      throw err
    }
  }

  const performDbMirror = (repo: Repo, force = false): Promise<DbMirrorRunReport> => {
    if (inFlight?.userId === repo.user.id) return inFlight.run
    const entry = {userId: repo.user.id} as {userId: string; run: Promise<DbMirrorRunReport>}
    entry.run = (async () => {
      try {
        return await mirrorOnce(repo, force)
      } finally {
        // Only if it is still OURS. DEFENCE IN DEPTH and unpinned: the effect
        // reconciler stops an effect before starting its replacement, so a
        // second user's run cannot begin while this one is in flight.
        if (inFlight === entry) inFlight = null
      }
    })()
    inFlight = entry
    return entry.run
  }

  /** How long before the next scheduled run, given what this one found. */
  const delayFor = (report: DbMirrorRunReport): number => {
    switch (report.outcome.kind) {
      case 'busy-elsewhere':
        // The `min` cannot bind while `MIN_INTERVAL_MINUTES` is 15 and this is
        // 5 — it is there so a shorter minimum interval later cannot make the
        // busy retry slower than the cadence itself. Unpinned, and it is meant
        // to stay that way.
        return Math.min(BUSY_RETRY_MS, report.intervalMs)
      // Come back when the copy another tab took actually ages out, rather than
      // on a fixed retry that would land early and take a second copy.
      case 'too-soon':
        return report.outcome.dueInMs
      default:
        return report.intervalMs
    }
  }

  const effect: AppEffect = {
    id: 'db-mirror.schedule',
    start: ({repo}) => {
      // No picker, no feature: there is no way for the user to have chosen a
      // folder, and nothing to re-check later in the same session.
      if (!supported()) return

      // Reporting the tick's own outcome, not just the run's: `mirrorOnce`
      // records a failure to the store, but a failure to READ the store cannot
      // be recorded there at all, and that is the one that would otherwise
      // leave the chip claiming a healthy mirror forever.
      let consecutiveFailures = 0
      const loop = job.start(
        async () => {
          try {
            const report = await performDbMirror(repo)
            consecutiveFailures = 0
            dbMirrorRuntimeHealth.report(undefined)
            return delayFor(report)
          } catch (err) {
            consecutiveFailures += 1
            dbMirrorRuntimeHealth.report(describeError(err))
            // Handled rather than rethrown, because the backoff is a function
            // of how many times this has failed and the job's own
            // `onFailureDelayMs` is a constant. The warning it would have
            // logged is logged here instead.
            console.warn('[db-mirror] run failed', err)
            return failureDelay(consecutiveFailures, lastKnownIntervalMs)
          }
        },
        {onFailureDelayMs: FAILURE_RETRY_MS},
      )

      // Everything below can throw before the disposer exists — the effect
      // runtime records `cleanup: undefined` for a `start` that threw, so the
      // loop would be armed with nothing able to stop it, ticking against a
      // repo that may since have been replaced.
      try {
        return startWatching(repo, loop)
      } catch (err) {
        loop.stop()
        throw err
      }
    },
  }

  /** The part of `start` that has a loop to tear down if it fails. */
  const startWatching = (repo: Repo, loop: LoopHandle): (() => void) => {
    // Publish the persisted state at once. Until something loads it the
    // snapshot is null and the health chip has nothing to show, so a
    // permission or disk failure recorded in a previous session would stay
    // invisible until the first scheduled run — which waits for a genuinely
    // idle main thread and may never come in a busy session.
    store
      .load(repo.user.id)
      .then(state => {
        // The reconciler restarts every effect when the WORKSPACE changes,
        // and this feature is per-database rather than per-workspace — so a
        // fresh first delay each time would let someone who switches
        // workspaces often postpone mirroring for good. Pick up where the
        // last completed run left off instead, never sooner than the job's
        // own floor, which exists to stay clear of boot.
        const {lastCheckedAt} = state.status
        if (lastCheckedAt === undefined) return
        const due = lastCheckedAt + state.settings.intervalMinutes * 60_000 - now()
        loop.rearmIn(Math.max(LAZY_DEEP_IDLE.minDelayMs, due))
      })
      .catch((err: unknown) => {
        console.warn('[db-mirror] could not read the mirror state at startup', err)
      })
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

    // LAST, after everything above that can throw: a `start` that throws has no
    // disposer recorded, so a `live` published before the throw would outlive
    // the loop it points at and contradict its own declaration.
    const mine = {resume: (delayMs: number) => loop.rearmIn(delayMs)}
    live = mine

    return () => {
      stopWatching()
      // Only if it is still ours — a restart for another user may already have
      // replaced it.
      if (live === mine) live = null
      loop.stop()
    }
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
        let report = await performDbMirror(repo, true)
        // A manual run can join a scheduled one that was already in flight and
        // gated itself on the cadence. That answers a question the user did not
        // ask, so take the copy. The join has settled by the time this reads,
        // so the retry is a fresh forced run and one is enough.
        if (report.outcome.kind === 'too-soon') report = await performDbMirror(repo, true)
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
