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
 * scheduled tick both go through `performDbMirror`, so the two cannot drift
 * apart or record their results differently. A manual run does deliberately
 * bypass the two cadence gates; see `force`.
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
import {
  DB_MIRROR_DEFAULTS,
  dbMirrorStore,
  type DbMirrorState,
  type DbMirrorStore,
  type DbMirrorVerdict,
} from './store.js'

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
 * than one that always does — and a runaway exponent reaches `Infinity`, which
 * the cap answers correctly, so it needs no clamp of its own.
 */
const failureDelay = (consecutive: number, intervalMs: number): number =>
  Math.min(intervalMs, FAILURE_RETRY_MS * 2 ** (consecutive - 1))

/** Another tab held the run lock. It may be mid-copy — or it may have crashed,
 *  closed, or failed — so this comes back well before the full cadence, which
 *  on a weekly setting would otherwise leave the survivor idle for days. */
export const BUSY_RETRY_MS = 5 * 60_000

/** How long is left of `window`, or undefined when it has passed — or when
 *  `elapsed` is negative, so a clock that jumped backwards defers nothing. The
 *  two cadence gates are the same question asked of different clocks, and this
 *  is the one place the "only forwards" rule is written. */
const remainingIn = (elapsed: number | undefined, window: number): number | undefined =>
  elapsed !== undefined && elapsed >= 0 && elapsed < window ? window - elapsed : undefined

/** A database whose log is still empty. Transient by nature — it is the window
 *  between a wipe or an import and sync writing the first event — so it gets a
 *  short retry like the busy path rather than the full cadence, which on a
 *  weekly setting left the warning up and no copy taken for a week after sync
 *  had already finished. Nothing else re-arms the job when sync completes. */
export const NO_IDENTITY_RETRY_MS = 60_000

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
  /** The database's log is empty, so there is nothing local to protect yet. */
  | {kind: 'no-identity'}
  | DbMirrorOutcome

export interface DbMirrorRunReport {
  outcome: DbMirrorTickResult
  /** Wall clock the loop should wait before the next run. */
  intervalMs: number
  /** Set when the run reached a verdict but could not RECORD it. Dropping a
   *  status write is cheap for a completed copy — the marker goes unrecorded
   *  and the next run copies again, the safe direction. It is not cheap for a
   *  verdict that produced NO copy: the persisted status then still describes
   *  the last healthy run, so the chip reports a mirror that is fine while
   *  nothing is being written. The tick surfaces this instead of clearing. */
  bookkeepingFailed?: string
}

export interface DbMirrorScheduleDeps {
  store?: DbMirrorStore
  mirror?: typeof runDbMirror
  withRunLock?: typeof withMirrorRunLock
  job?: CadencedIdleJob
  now?: () => number
}

/** The controls of a started effect, and its identity. A run can outlive the
 *  effect that started it, so anything shared it touches afterwards compares
 *  against the CURRENT one rather than assuming it is still that. */
interface LiveEffect {
  resume: (delayMs: number) => void
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

export const describeError = (err: unknown): string =>
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
  now = Date.now,
}: DbMirrorScheduleDeps = {}): DbMirrorSchedule => {
  /** The running effect's controls, or null while no effect is started. */
  let live: LiveEffect | null = null
  /** ONE copy at a time IN THIS TAB. The loop cannot overlap itself, but
   *  "Mirror now" can land in the middle of a scheduled run, so a second caller
   *  joins the run already going. Keyed by user: signing out in local-only mode
   *  swaps the repo without a reload, and joining across that would hand the new
   *  user the previous one's report for a copy of a database that is no longer
   *  theirs. Other TABS are excluded by `withMirrorRunLock`. */
  let inFlight: {userId: string; run: Promise<DbMirrorRunReport>} | null = null

  /** Consecutive failures, kept OUTSIDE the effect. The reconciler restarts
   *  every effect on a workspace change, so a per-effect counter made every
   *  attempt a first attempt for anyone who switches workspaces at all — the
   *  ladder never widened, and a destination that always reaches the export's
   *  three-minute deadline then held the write lock for most of every cycle.
   *  Any run that gets through resets it. */
  let consecutiveFailures = 0

  /** The interval this schedule last actually READ, for the failure path —
   *  which has no report to take one from, and must not go back to storage that
   *  may be what failed. Remembered rather than re-derived from the snapshot,
   *  because the snapshot is null in exactly the case this exists for, and the
   *  default it fell back to could be longer than the interval the user chose. */
  let lastKnownIntervalMs = DB_MIRROR_DEFAULTS.intervalMinutes * 60_000

  /** Best effort, like pruning. A status write is bookkeeping ABOUT the run: it
   *  must not turn a finished copy into a failure, and on the error path it
   *  must not replace the error the caller is about to see with its own. A
   *  dropped write costs one redundant copy next run, since the marker went
   *  unrecorded — the safe direction. */
  const recordStatus = async (
    userId: string,
    patch: Parameters<DbMirrorStore['recordStatus']>[1],
    opts: {ifDirectoryEpoch: number | undefined},
  ): Promise<string | undefined> => {
    try {
      await store.recordStatus(userId, patch, opts)
      return undefined
    } catch (err) {
      console.warn('[db-mirror] could not record the run status', err)
      return describeError(err)
    }
  }

  /** Records what a run CONCLUDED about the database and the folder, so the chip
   *  can report that rather than infer it from the copy fields.
   *
   *  The outcomes that decide nothing about either — mirroring off, no folder
   *  chosen, another tab holding the lock, this one inside the cadence — do not
   *  come through here, and deliberately: they would overwrite a verdict that is
   *  still the most recent thing known about the mirror itself. */
  const conclude = async (
    userId: string,
    at: number,
    kind: DbMirrorVerdict,
    patch: Parameters<DbMirrorStore['recordStatus']>[1],
    opts: {ifDirectoryEpoch: number | undefined},
  ): Promise<string | undefined> =>
    recordStatus(userId, {
      // A run that reached a verdict at all got past the permission check and
      // the folder, so any failure on the record describes a state that is
      // over. Cleared by DEFAULT rather than per-branch: leaving it to each
      // caller is how a week-old "the disk is full" came to shadow a current
      // verdict on the chip, which is the inference recording verdicts was
      // meant to replace. The two branches that ARE reporting a failure put it
      // back in their own patch.
      lastError: undefined,
      lastErrorAt: undefined,
      ...patch,
      lastOutcome: kind,
      lastOutcomeAt: at,
    }, opts)

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
    const at = now()
    // Captured with the folder, and handed back to every write about the copy.
    // A run is not instantaneous: the user can pick a NEW folder while a
    // multi-gigabyte copy into the old one is still going, and the result would
    // then describe a folder nobody is looking at any more — while its fresh
    // `lastCheckedAt` deferred the first copy into the new folder for a whole
    // interval. The store rejects the write if the folder has moved on.
    const ifDirectoryEpoch = state.directoryEpoch
    /** Every verdict this run records, pinned to the folder it was started
     *  against. A bare `conclude` is reachable from here and would silently
     *  drop that pin — the throw path did exactly that, so a failure copying
     *  into the OLD folder could land on the NEW folder's freshly cleared
     *  status, or overwrite a good verdict from it. */
    const concludeHere = (
      kind: DbMirrorVerdict,
      patch: Parameters<DbMirrorStore['recordStatus']>[1] = {},
    ): Promise<string | undefined> => conclude(userId, at, kind, patch, {ifDirectoryEpoch})
    // Every path that turns mirroring on is a persisting write, and those mint
    // the install id — so reaching here without one means a half-written
    // record. Minting it now rather than carrying an "install unknown" state
    // through the run is what keeps ownership decidable: a copy whose install
    // group we do not recognise is a copy nothing can ever reclaim.
    // Not folder-scoped: it mints an id and touches no status field.
    const installId =
      state.installId ?? (await store.recordStatus(userId, {}, {ifDirectoryEpoch: undefined})).installId
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
    const reading = await readDatabaseIncarnation(repo)
    const incarnation = reading.kind === 'known' ? reading.id : undefined
    // Whether the record in front of us describes the database in front of us.
    // An EMPTY log settles it in the negative rather than leaving it unknown:
    // `row_events` is never trimmed, so a database with recorded history cannot
    // have an empty log, and a status carrying one therefore belongs to a
    // database this device no longer holds. An UNREADABLE log settles nothing,
    // so the record is left as it stands.
    const describesThisDatabase =
      incarnation !== undefined && state.status.incarnation === incarnation
    const knownStale = reading.kind === 'empty' || (reading.kind === 'known' && !describesThisDatabase)
    // CLEARED here rather than filtered by each reader: the chip and the
    // settings surface both rendered the previous database's last copy as this
    // one's, and a record that is only true if you remember to check a
    // neighbouring field is a record that will be read wrong. Before the
    // empty-log return below, because that is the post-wipe window itself — a
    // rebuilt database has an empty log until sync repopulates it, which is
    // exactly when the stale record is on screen.
    if (knownStale && state.status.lastOutcome !== undefined) {
      await recordStatus(userId, {
        incarnation,
        lastMarker: undefined,
        lastMirrorAt: undefined,
        lastCheckedAt: undefined,
        lastFilename: undefined,
        lastBytes: undefined,
        unmanagedCopies: undefined,
        unprunableCopies: undefined,
      }, {ifDirectoryEpoch})
    }
    // An empty log is the one case that warrants no copy at all; an unreadable
    // one still takes a copy. `readDatabaseIncarnation` owns why they differ.
    if (reading.kind === 'empty') {
      const bookkeepingFailed = await concludeHere('no-identity')
      return {outcome: {kind: 'no-identity'}, intervalMs, bookkeepingFailed}
    }

    // The interval belongs to the DEVICE, not to this tab's timer: every tab
    // runs its own loop against the same folder, so N tabs otherwise take N
    // copies per interval. The run-lock winner records `lastCheckedAt`; this is
    // where the others read it.
    //
    // Only for a status that describes THIS database — one recorded before an
    // import or a wipe says nothing about the copy that is due now — and only
    // forwards, so a clock that jumped backwards defers nothing.
    const sinceLastRun =
      describesThisDatabase && state.status.lastCheckedAt !== undefined
        ? at - state.status.lastCheckedAt
        : undefined
    // A run that THREW holds the device off too, but only for the first retry
    // step rather than the whole interval — long enough that an effect restart
    // (every workspace change) or a second tab does not immediately repeat an
    // attempt that holds PowerSync's write lock for its full deadline, and
    // short enough that it never defers the retry the failing tab itself asked
    // for, which is what stamping `lastCheckedAt` here used to do.
    //
    // Only a throw. The other verdicts that produce no copy are cheap — a
    // permission check that never prompts, one indexed row lookup — so there is
    // nothing to protect against repeating, and gating them would make a user
    // who has just re-granted the folder wait out a retry step for nothing.
    const sinceLastAttempt =
      state.status.lastOutcomeAt !== undefined && state.status.lastOutcome === 'failed'
        ? at - state.status.lastOutcomeAt
        : undefined
    const dueInMs = force
      ? undefined
      : remainingIn(sinceLastRun, intervalMs) ?? remainingIn(sinceLastAttempt, FAILURE_RETRY_MS)
    if (dueInMs !== undefined) return {outcome: {kind: 'too-soon', dueInMs}, intervalMs}

    try {
      let bookkeepingFailed: string | undefined
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
          await concludeHere('mirrored', {
            incarnation,
            unmanagedCopies: outcome.unmanaged,
            unprunableCopies: outcome.unprunable,
            permissionLost: false,
            // Only a copy we read back is recorded AS the copy. An unverified
            // one is probably fine, but claiming it would have the chip assert
            // a backup nothing has seen for a whole interval — a week at the
            // longest cadence — and would let the next run skip against a file
            // it never confirmed. Withholding the marker makes that run copy
            // again instead, which is the cheap direction.
            ...(outcome.verified
              ? {
                  lastMarker: outcome.marker,
                  lastMirrorAt: at,
                  lastCheckedAt: at,
                  lastFilename: outcome.filename,
                  lastBytes: outcome.bytes,
                }
              : {}),
          })
          break
        case 'skipped-unchanged':
          // Reaching here means the permission held and the folder was read, so
          // any recorded failure describes a state that is over — leaving it
          // would have the chip report a paused mirror that is running fine.
          await concludeHere('skipped-unchanged', {
            lastCheckedAt: at,
            unmanagedCopies: outcome.unmanaged,
            unprunableCopies: outcome.unprunable,
            permissionLost: false,
          })
          break
        case 'permission-lost':
          bookkeepingFailed = await concludeHere('permission-lost', {
            permissionLost: true,
            lastError: PERMISSION_LOST_MESSAGE,
            lastErrorAt: at,
          })
          break
        default: {
          // Exhaustiveness: a new outcome kind is a compile error here rather
          // than a run that silently records nothing. The dialog's switch
          // carries the same guard, and its comment records why.
          const unhandled: never = outcome
          console.warn('[db-mirror] unhandled run outcome', unhandled)
        }
      }
      return {outcome, intervalMs, bookkeepingFailed}
    } catch (err) {
      await concludeHere('failed', {
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

  /** Stop future callers joining the run in flight, without disturbing the run
   *  itself — its own `finally` then finds the slot already taken from it and
   *  leaves whatever replaced it alone. */
  const detachInFlight = (): void => { inFlight = null }

  const performDbMirror = (repo: Repo, force = false): Promise<DbMirrorRunReport> => {
    if (inFlight?.userId === repo.user.id) return inFlight.run
    const run: Promise<DbMirrorRunReport> = mirrorOnce(repo, force).finally(() => {
      // Only if it is still OURS, and that is load-bearing rather than a
      // formality. Stopping an effect does NOT recall a run already in flight —
      // `loop.stop` cancels a pending timer and nothing more — so a copy can
      // outlast the replacement effect's first tick. Clearing unconditionally
      // would drop the new user's entry while their run is still going, and the
      // next caller would start a second one overlapping it in this same tab.
      if (inFlight?.run === run) inFlight = null
    })
    inFlight = {userId: repo.user.id, run}
    return run
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
      case 'no-identity':
        return Math.min(NO_IDENTITY_RETRY_MS, report.intervalMs)
      default:
        return report.intervalMs
    }
  }

  /** The part of `start` that has a loop to tear down if it fails. */
  const startWatching = (repo: Repo, loop: LoopHandle, mine: LiveEffect): (() => void) => {
    // Publish the persisted state at once. Until something loads it the
    // snapshot is null and the health chip has nothing to show, so a
    // permission or disk failure recorded in a previous session would stay
    // invisible until the first scheduled run — which waits for a genuinely
    // idle main thread and may never come in a busy session.
    store
      .load(repo.user.id)
      .then(async state => {
        // The reconciler restarts every effect when the WORKSPACE changes,
        // and this feature is per-database rather than per-workspace — so a
        // fresh first delay each time would let someone who switches
        // workspaces often postpone mirroring for good. Pick up where the
        // last completed run left off instead, never sooner than the job's
        // own floor, which exists to stay clear of boot.
        const {lastCheckedAt} = state.status
        if (lastCheckedAt === undefined) return
        // And only when it describes the database in front of us. After a wipe
        // or an import, IndexedDB still holds the PREVIOUS database's
        // timestamp, and deferring to it parks the first tick up to a whole
        // interval out — a week at the longest cadence. `mirrorOnce` is what
        // clears that stale record, so trusting it here postpones the very run
        // that would fix it, through exactly the window in which no copy of the
        // new database exists and the settings surface still names the old one.
        const reading = await readDatabaseIncarnation(repo)
        if (reading.kind !== 'known' || state.status.incarnation !== reading.id) return
        const intervalMs = state.settings.intervalMinutes * 60_000
        // Clamped at BOTH ends. A `lastCheckedAt` written while the device
        // clock was fast makes `due` arbitrarily large, and the loop would then
        // sit past it — across reloads, since every restart re-reads the same
        // record — while nothing looked wrong: the cadence gate and
        // `isMirrorStalled` both read a negative age as "recent". Never longer
        // than one interval is the same answer a fresh session would give.
        const due = lastCheckedAt + intervalMs - now()
        loop.rearmIn(Math.min(intervalMs, Math.max(LAZY_DEEP_IDLE.minDelayMs, due)))
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
    /** Everything about the settings that decides WHEN the next copy is due.
     *  The settings surface re-arms the tab it runs in; the store's broadcast is
     *  what carries the change to the others, and they have no other way to
     *  hear it — so anything left out here leaves every OTHER tab sitting on a
     *  delay chosen before the change, which on a weekly cadence is a week with
     *  the newly chosen folder empty. */
    const eligibilityOf = (state: DbMirrorState | null) => ({
      interval: state?.settings.intervalMinutes,
      enabled: state?.settings.enabled,
      folder: state?.directoryEpoch,
    })
    let armedFor = eligibilityOf(store.getSnapshot())
    const stopWatching = store.subscribe(() => {
      const next = eligibilityOf(store.getSnapshot())
      if (next.interval === undefined) return
      // A run started against the PREVIOUS folder answers a question about a
      // folder nobody is looking at any more. Detaching it is what stops the
      // next tick JOINING it on a matching user id and adopting its `mirrored`
      // verdict — and its full interval — for a folder it never wrote a byte
      // to. The run itself continues, and its own status write is refused by
      // the epoch.
      if (next.folder !== armedFor.folder) detachInFlight()
      const changed =
        next.interval !== armedFor.interval ||
        next.enabled !== armedFor.enabled ||
        next.folder !== armedFor.folder
      // The FIRST reading is a baseline, not a change: the loop has just been
      // armed on the job's own short first delay, and re-arming it to the full
      // interval here would push a fresh session's first copy a cadence out.
      const baseline = armedFor.interval === undefined
      const onlyTheInterval = next.folder === armedFor.folder && next.enabled === armedFor.enabled
      armedFor = next
      if (!changed || baseline) return
      // A new folder or a fresh opt-in is due NOW, not one cadence from now;
      // only a changed interval re-times the schedule that is already running.
      loop.rearmIn(onlyTheInterval ? next.interval * 60_000 : 0)
    })

    // LAST, after everything above that can throw: a `start` that throws has no
    // disposer recorded, so a `live` published before the throw would outlive
    // the loop it points at and contradict its own declaration.
    live = mine

    return () => {
      stopWatching()
      // Only if it is still ours — a restart for another user may already have
      // replaced it.
      if (live === mine) live = null
      loop.stop()
      // The signal is module-global and says nothing about WHOSE run failed.
      // Local-only sign-out swaps the repo without a reload, so leaving it set
      // shows the previous account's failure against the new account's mirror
      // until a tick clears it — and the first tick waits for a genuinely idle
      // main thread, which a busy session may never give.
      dbMirrorRuntimeHealth.report(undefined)
    }
  }

  const effect: AppEffect = {
    id: 'db-mirror.schedule',
    start: ({repo}) => {
      // THIS effect's identity, created before the loop so the tick body can
      // ask whether it is still the live one. Stopping an effect does not
      // recall a run already in flight — `loop.stop` cancels a pending timer
      // and nothing more — so a continuation can outlive its effect by minutes.
      // Everything shared it might touch on the way out is gated on this: the
      // re-arm, and the module-global health channel, where a stale error
      // otherwise sits against the NEW account's mirror until its first idle
      // tick, which a busy session may never give.
      const mine: LiveEffect = {resume: () => {}}
      const isLive = (): boolean => live === mine

      // Reporting the tick's own outcome, not just the run's: `mirrorOnce`
      // records a failure to the store, but a failure to READ the store cannot
      // be recorded there at all, and that is the one that would otherwise
      // leave the chip claiming a healthy mirror forever.
      const loop = job.start(
        async () => {
          try {
            const report = await performDbMirror(repo)
            consecutiveFailures = 0
            if (isLive()) dbMirrorRuntimeHealth.report(report.bookkeepingFailed)
            return delayFor(report)
          } catch (err) {
            consecutiveFailures += 1
            if (isLive()) dbMirrorRuntimeHealth.report(describeError(err))
            // Handled rather than rethrown, because the backoff is a function
            // of how many times this has failed and the job's own
            // `onFailureDelayMs` is a constant. The warning it would have
            // logged is logged here instead.
            console.warn('[db-mirror] run failed', err)
            return failureDelay(consecutiveFailures, lastKnownIntervalMs)
          }
        },
        // A backstop only: the body above handles its own failure and returns a
        // delay, so nothing on the remaining path can throw.
        {onFailureDelayMs: FAILURE_RETRY_MS},
      )
      mine.resume = (delayMs: number) => loop.rearmIn(delayMs)

      // Everything below can throw before the disposer exists — the effect
      // runtime records `cleanup: undefined` for a `start` that threw, so the
      // loop would be armed with nothing able to stop it, ticking against a
      // repo that may since have been replaced.
      try {
        return startWatching(repo, loop, mine)
      } catch (err) {
        loop.stop()
        throw err
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
