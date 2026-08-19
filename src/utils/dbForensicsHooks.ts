/**
 * Wiring between the app boot/lifecycle and the out-of-band {@link dbForensics}
 * recorder. Kept separate from `dbForensics` (pure store) and from
 * `repoProvider` (which just calls these) so the glue — the per-user watcher,
 * the lifecycle listeners, the retrieval hook — lives in one place.
 */

import { dbForensics, type DbForensics } from '@/utils/dbForensics.js'
import {
  isLocalDbCorruptionError,
  isRuntimeDbCorruptionError,
  messageChainOf,
} from '@/utils/localDbCorruption.js'
import { reportRuntimeLocalDbCorruption } from '@/data/localDbCorruptionSignal.js'
import {
  materializeQueueCountSql,
  rejectedQueueCountSql,
  uploadQueueEdgeSql,
  uploadQueuePreviewCountSql,
  uploadQueueRowCountSql,
} from '@/data/syncQueueSql.js'

// Structural PowerSync status surface (avoids importing PowerSync types; see
// firstSync.ts for the same approach). `downloadError` lives under
// `dataFlowStatus` in current PowerSync, but check both shapes defensively.
interface DownloadErrorStatus {
  dataFlowStatus?: { downloadError?: unknown }
  downloadError?: unknown
}
interface CorruptionWatchDb {
  currentStatus?: DownloadErrorStatus
  registerListener?: (l: { statusChanged?: (s: DownloadErrorStatus) => void }) => () => void
}

const downloadErrorOf = (s: DownloadErrorStatus | undefined): unknown =>
  s?.dataFlowStatus?.downloadError ?? s?.downloadError

let sessionRecorded = false
let lifecycleInstalled = false
// The runtime watcher is bound to a specific user's connection. An in-page
// account switch (onAuthStateChange → new user.id, no reload) re-runs
// `ensurePowerSyncReady` for the new user, so we must tear down the previous
// user's listener and re-arm — else the new user goes unwatched AND the stale
// listener could report the OLD user's corruption into the new session (routing
// a reset at the wrong user's `.db`).
let watchedUserId: string | null = null
let disposeWatch: (() => void) | null = null
let runtimeCorruptionCaptured = false

/**
 * Record a new forensic session (unclean-shutdown detection). Once per page
 * load — the session is the page-load lifetime, so later `ensurePowerSyncReady`
 * calls (re-render / in-page account switch) are no-ops. Best-effort; never throws.
 */
export const recordForensicSessionStart = (
  userId: string,
  dbFilename: string,
  forensics: DbForensics = dbForensics,
): void => {
  if (sessionRecorded) return
  sessionRecorded = true
  void forensics.recordSessionStart({ userId, dbFilename })
}

/** Capture a forensic snapshot on a DB-OPEN corruption, before recovery. */
export const captureDbOpenCorruption = (
  userId: string,
  dbFilename: string,
  error: unknown,
  forensics: DbForensics = dbForensics,
): void => {
  if (!isLocalDbCorruptionError(error)) return
  void forensics.captureCorruptionSnapshot({
    userId,
    dbFilename,
    reason: 'db-open-corrupt',
    sql: { message: messageChainOf(error) },
  })
}

/**
 * Watch the PowerSync connection for a RUNTIME sync-apply corruption
 * (`downloadError`) — the class the DB-open detector never sees (connect isn't
 * awaited). On the first corruption it captures a forensic snapshot AND routes
 * to the recovery UI via `reportRuntimeLocalDbCorruption` → the sentinel → the
 * bootstrap ErrorBoundary. Both gate on the strict, reset-gating matcher so a
 * benign sync failure neither consumes the one-shot capture nor shows the UI.
 *
 * Re-arms per user: on an in-page account switch it disposes the previous
 * listener and rebinds to the new user's db.
 */
export const watchForRuntimeCorruption = (
  db: CorruptionWatchDb,
  userId: string,
  dbFilename: string,
  forensics: DbForensics = dbForensics,
): void => {
  if (watchedUserId === userId) return
  disposeWatch?.()
  disposeWatch = null
  watchedUserId = userId
  runtimeCorruptionCaptured = false // re-arm the one-shot capture for the new user

  const check = (status: DownloadErrorStatus | undefined): void => {
    const err = downloadErrorOf(status)
    // Tight matcher: `downloadError` also carries benign HTTP/network failures
    // whose server body could echo a broad corruption phrase — those must NOT
    // route to the destructive recovery UI.
    if (err === undefined || err === null || !isRuntimeDbCorruptionError(err)) return
    if (!runtimeCorruptionCaptured) {
      runtimeCorruptionCaptured = true
      void forensics.captureCorruptionSnapshot({
        userId,
        dbFilename,
        reason: 'runtime-sync-corrupt',
        sql: { downloadError: messageChainOf(err) },
      })
    }
    // Route to the recovery UI (latched in the signal, so repeated sync-loop
    // failures don't re-fire).
    reportRuntimeLocalDbCorruption(userId, err)
  }

  check(db.currentStatus)
  disposeWatch = typeof db.registerListener === 'function'
    ? db.registerListener({ statusChanged: check })
    : null
}

// Structural PowerSync status/db surface for the sync-health sampler (avoids
// importing PowerSync types, same convention as CorruptionWatchDb above and
// firstSync.ts's SyncStatusDb). Two candidate containers for the data-flow
// fields — `dataFlowStatus` (the live `SyncStatus` class's getter) and
// `dataFlow` (the plain-object shape `SyncStatus#toJSON()` produces, e.g. if
// status ever crosses a worker boundary) — read both defensively, same reason
// the corruption watcher above checks both `dataFlowStatus` and a top-level
// fallback for `downloadError`.
interface SyncFlowFields {
  uploading?: boolean
  downloading?: boolean
  uploadError?: unknown
  downloadError?: unknown
}
interface SyncStatusLike {
  connected?: boolean
  connecting?: boolean
  hasSynced?: boolean | null
  lastSyncedAt?: Date | number | null
  dataFlow?: SyncFlowFields
  dataFlowStatus?: SyncFlowFields
}
interface SyncHealthDb {
  currentStatus?: SyncStatusLike
  registerListener?: (l: { statusChanged?: (s: SyncStatusLike) => void }) => () => void
  getAll?: (sql: string) => Promise<unknown[]>
}

const flowField = <K extends keyof SyncFlowFields>(
  s: SyncStatusLike | undefined,
  key: K,
): SyncFlowFields[K] => s?.dataFlowStatus?.[key] ?? s?.dataFlow?.[key]

const toEpochMs = (v: Date | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null
  return v instanceof Date ? v.getTime() : v
}

// Truncated so a verbose/runaway error message can't dominate the ring.
const SYNC_ERROR_MAX_LEN = 200
const errorMessageOf = (error: unknown): string | null => {
  if (error === undefined || error === null) return null
  const msg = messageChainOf(error)
  return msg.length > SYNC_ERROR_MAX_LEN ? msg.slice(0, SYNC_ERROR_MAX_LEN) : msg
}

interface CountRow { count: number }
const countOf = (rows: unknown[]): number | null => {
  const row = rows[0] as CountRow | undefined
  const n = row ? Number(row.count) : NaN
  return Number.isFinite(n) ? n : null
}

// Best-effort single count query — null (not a throw) on any failure or a
// db with no `getAll`. A sample with a null count is far better than no
// sample at all (the whole point of this module, per the iPad incident).
const safeCount = async (db: SyncHealthDb, sql: string): Promise<number | null> => {
  if (typeof db.getAll !== 'function') return null
  try {
    return countOf(await db.getAll(sql))
  } catch {
    return null
  }
}

interface QueueEdgeRow { lo: number | null; hi: number | null }
/** Best-effort `uploadQueueEdgeSql` query — `null` (not a throw) on any
 *  failure or a db with no `getAll`, exactly like {@link safeCount}. A
 *  successful, empty-queue result is `{ lo: null, hi: null }` (SQLite's
 *  MIN/MAX over zero rows) — that is NOT a failure and must stay
 *  distinguishable from one, since `computeSyncStall` treats "queue empty"
 *  and "unknown" very differently (see that function's doc). */
const safeQueueEdge = async (db: SyncHealthDb): Promise<QueueEdgeRow | null> => {
  if (typeof db.getAll !== 'function') return null
  try {
    const rows = await db.getAll(uploadQueueEdgeSql)
    const row = rows[0] as QueueEdgeRow | undefined
    if (!row) return null
    return { lo: row.lo ?? null, hi: row.hi ?? null }
  } catch {
    return null
  }
}

/** A queue with unsynced blocks that hasn't synced in this long is worth
 *  flagging on its own — the 2026-08-13 iPad incident sat at 16.3 hours. */
export const SYNC_STALL_THRESHOLD_MS = 10 * 60_000
/** How often the watcher re-samples on its own (independent of `statusChanged`
 *  firing). Cheap even at this cadence because `recordSyncSample` coalesces a
 *  run of identical samples into one ring entry (see dbForensics.ts) — a
 *  healthy, unchanging connection costs one ring slot no matter how many
 *  intervals fire. */
export const SYNC_SAMPLE_INTERVAL_MS = 60_000

let syncWatchedUserId: string | null = null
let disposeSyncWatch: (() => void) | null = null
let syncIntervalId: ReturnType<typeof setInterval> | null = null
// Epoch ms this watcher ARMED (watchSyncHealth's call, not any persisted
// timestamp). Exists solely to gate `syncStale` in `computeSyncStall` — see
// that function's doc for the boot false-positive this fixes.
let syncArmedAt = 0
// Epoch ms the CURRENT unbroken run of the queue being non-empty began, or
// null when the queue is empty. Independent of `lastSyncedAt`: `lastSyncedAt`
// advances on every DOWNLOAD checkpoint, so it stays "fresh" even when
// uploads are wedged and downloads keep working — one of the two live
// hypotheses for the 2026-08-13 incident, and a stall condition keyed only on
// `lastSyncedAt` can't see it. This clock is the second, independent signal.
// Owned by `computeSyncStall` (see its doc): reset not just when the queue
// empties but whenever `ps_crud`'s `MIN(id)` boundary ADVANCES (a batch
// drained), so a backlog that's genuinely draining never reads as a stall
// just because draining took longer than the threshold. LIMITATION: it's
// in-memory, not persisted, so a stall spanning a restart re-arms each boot
// and only flags again ~SYNC_STALL_THRESHOLD_MS into the new session —
// acceptable (the incident's four restarts didn't drain the queue either
// way; the ring + stall-episode log still show the pre-restart state via
// `recordSessionStart`'s archive).
let syncPendingSince: number | null = null
// Last KNOWN `lo` (MIN(id) over ps_crud) — null if unknown-so-far or if the
// queue was empty as of that sample. Only updated when the edge query
// SUCCEEDS (mirrors `syncPendingSince`'s "unknown must not erase known
// state" discipline) — a transient query failure must not be misread as "no
// progress".
let syncLastLo: number | null = null
// The stall verdict as of the last sample where the edge query succeeded —
// fed into `computeSyncStall` as `previousStall` on the next call. A
// SEPARATE variable from `openStallEpisodeKey` (which tracks whether a
// DURABLE episode is open) on purpose: an episode stays open across a
// dribble even while the raw `stall` verdict itself blips false (see
// `computeSyncStall`'s and `StallEpisode`'s docs) — conflating the two was
// the mechanism behind the fabricated-per-dribble-resolution bug.
let syncLastStallVerdict = false
// The currently-open stall episode's store key (see dbForensics.ts
// recordStallEpisode/closeStallEpisode), or null when nothing is open. Tracked
// here because the store has no notion of "the current" episode — only the
// watcher knows which one is still in flight. `openStallEpisodeKey === null`
// IS the "no episode open" signal (no separate boolean latch needed) — an
// episode transition, and the once-per-episode console.warn, both key off
// this directly.
let openStallEpisodeKey: string | null = null
// Consecutive KNOWN samples (edge query succeeded) in a row where `queueOld`
// was true — the watchdog's own eligibility gate (item 7: it may act only on
// the queue-age condition, held for at least 2 consecutive samples, never on
// `syncStale` alone). A sample where the edge query fails leaves this
// UNCHANGED (same "unknown retains, doesn't reset" discipline as
// `pendingSince`/`syncLastStallVerdict` above) rather than either advancing
// or resetting it.
let consecutiveQueueOldSamples = 0
// Latched at NOTIFICATION time (in the `statusChanged` listener itself, off
// the delivered status payload), OR'd across every notification since the
// last sample consumed it, then folded into that sample's own
// uploadingSeen/downloadingSeen and reset. This exists because PowerSync
// sets `uploading`/`downloading` true immediately before awaiting the
// upload/download call and clears it again on failure — a fast-fail loop can
// toggle true→false before the (throttled/coalesced — see `enqueueSample`)
// sampler ever gets around to reading `db.currentStatus`, so reading the
// status only at SAMPLE time misses the toggle entirely. Collapsing
// (coalescing repeated identical samples into one ring entry) is right for
// the expensive counts; it is wrong for these edge-triggered booleans, which
// is exactly why they're captured independently of the sampler's own
// cadence.
let latchedUploadingSeen = false
let latchedDownloadingSeen = false
// Bumped on every `stopSyncHealthWatch()` (including watchSyncHealth's own
// internal re-arm). Each `watchSyncHealth` call captures the CURRENT value
// once, at arm time, and threads it through every sample it schedules for
// the life of that arm. A sample already in flight (suspended on its count
// queries) when a teardown/re-arm happens keeps its OLD captured value, so
// comparing against the live `watchGeneration` after resuming tells it its
// arm has since been torn down — see `sampleSyncHealth`'s guard, right after
// the counts come back and before ANY module global is touched. Fixes the
// proven cross-user corruption: without this, user A's sample suspended
// mid-flight can resume AFTER `stopSyncHealthWatch()` + re-arm for user B
// and write the freshly-zeroed module globals above under B's watcher (and
// even call reconnect for A).
let watchGeneration = 0

/**
 * The stall predicate — factored out to ONE definition because it is read
 * from two places that must never disagree: `sampleSyncHealth` below (which
 * stamps `stall` onto every recorded sample/episode) and the reconnect
 * watchdog (`runReconnectWatchdog`, also below), which decides whether to
 * fire `sync.reconnect` off the SAME condition. If the watchdog re-derived
 * its own version, a future edit to one copy and not the other would make
 * the forensics dump and the recovery behavior it's supposed to explain
 * silently diverge — exactly the kind of drift this module exists to catch
 * elsewhere (e.g. `downloadErrorOf`'s shared field lookup).
 *
 * This function owns the FULL `pendingSince` lifecycle, not just the stall
 * verdict — deliberately, so every rule about what "how long has the queue
 * been stuck" means lives in exactly one place:
 *
 * - The queue-age half (`queueOld`) is independently load-bearing, not just
 *   belt-and-suspenders: `lastSyncedAt` advances on every DOWNLOAD
 *   checkpoint, so it stays "fresh" even when uploads are wedged and
 *   downloads keep working — one of the two live hypotheses for the
 *   2026-08-13 incident. A predicate keyed only on `lastSyncedAt` can't see
 *   that split at all.
 * - `syncStale` may ALSO only fire once `now - armedAt` exceeds the
 *   threshold — not just `now - lastSyncedAt`. `lastSyncedAt` is populated
 *   from PERSISTED PowerSync state before this session's connection even
 *   exists (`AbstractPowerSyncDatabase.initialize()` reads it off disk), so
 *   closing the app at 22:00 with a queued edit and reopening at 08:00 makes
 *   the very first sample see a 10-hour-old `lastSyncedAt` and a non-empty
 *   queue — a false stall on sample #1, before this session has even had a
 *   chance to observe a real connection attempt. Gating on session-local
 *   `armedAt` (mirroring the in-memory-only discipline `pendingSince`
 *   already uses) means `syncStale` can only fire once THIS session has been
 *   watching for longer than the threshold, so a persisted timestamp alone
 *   can never trigger it. `queueOld` needs no equivalent gate: `pendingSince`
 *   is itself in-memory-only and always starts at `now` on a fresh
 *   observation, so it can never be "old" faster than this session has
 *   actually been running.
 * - `loKnown === false` means the `ps_crud` edge query (`MIN(id)`/`MAX(id)`)
 *   FAILED this sample, not that the queue is empty. Unknown must NOT read as
 *   "not stalled" — that would let a single transient query failure look
 *   like a resolution, closing whatever stall episode is open and
 *   fabricating a clock reset that splits one real incident into two.
 *   Unknown retains the PREVIOUS verdict (`previousStall`) and leaves
 *   `pendingSince` untouched instead.
 * - `lo` ADVANCING (compared to `lastLo`, the last KNOWN `lo`) resets
 *   `pendingSince` to `now`, same as the queue draining to zero (`lo ===
 *   null`). `ps_crud.id` is the table's rowid, and PowerSync drains a
 *   completed upload batch with `DELETE FROM ps_crud WHERE id <= ?` (see
 *   `uploadQueueEdgeSql`'s doc in syncQueueSql.ts) — so `lo` only ever moves
 *   up, and an increase is EXACTLY "the upload loop completed a batch since
 *   the last observation," at any queue depth, with no cap (this replaces
 *   the old heuristic of a DECREASE in two capped counts, which read flat —
 *   and so false-positived — on a backlog above the cap). A legitimate
 *   backlog (a long offline stretch catching up, a slow link) keeps the
 *   queue non-empty for well over the threshold while genuinely draining;
 *   without this reset it reads as a stall and the watchdog "recovers" by
 *   disconnecting an upload stream that was making real progress, on every
 *   backoff step, since the queue never empties long enough to reset the
 *   schedule. A wedged queue's `lo` never moves, so it still trips.
 */
export const computeSyncStall = (params: {
  /** `MIN(id)` over `ps_crud`, or `null` if the queue is empty. Meaningless
   *  (ignored) when `loKnown` is `false` — the query failed this sample. */
  lo: number | null
  /** `false` when the `ps_crud` edge query failed this sample (unknown
   *  state) — see the function doc's `loKnown` bullet. */
  loKnown: boolean
  /** Last KNOWN `lo` (from a sample where `loKnown` was true), or `null` if
   *  unknown-so-far or that sample's queue was empty. */
  lastLo: number | null
  lastSyncedAt: number | null
  pendingSince: number | null
  /** Epoch ms this watcher armed — see the function doc's `syncStale` bullet. */
  armedAt: number
  now: number
  /** The stall verdict as of the last sample where the edge query
   *  succeeded — returned verbatim when THIS sample's `loKnown` is false. */
  previousStall: boolean
}): { stall: boolean; pendingSince: number | null; progressed: boolean; queueOld: boolean } => {
  if (!params.loKnown) {
    return { stall: params.previousStall, pendingSince: params.pendingSince, progressed: false, queueOld: false }
  }

  let pendingSince = params.pendingSince
  const progressed = params.lo !== null && params.lastLo !== null && params.lo > params.lastLo
  if (params.lo === null) {
    pendingSince = null
  } else if (pendingSince === null || progressed) {
    pendingSince = params.now
  }

  const syncStale =
    params.lastSyncedAt !== null &&
    params.now - params.lastSyncedAt > SYNC_STALL_THRESHOLD_MS &&
    params.now - params.armedAt > SYNC_STALL_THRESHOLD_MS
  const queueOld = pendingSince !== null && params.now - pendingSince > SYNC_STALL_THRESHOLD_MS
  const stall = params.lo !== null && (syncStale || queueOld)
  return { stall, pendingSince, progressed, queueOld }
}

/** Reconnect-watchdog backoff ladder (minutes → ms): 10 → 20 → 40, capped at
 *  60 (~1h). Index `i` is the gap required after the `(i+1)`-th attempt in
 *  the current stall episode before the `(i+2)`-th is allowed — see
 *  `runReconnectWatchdog`. Once the episode has escalated past the last
 *  step, every subsequent attempt reuses that step (the cap): the array
 *  never grows and `watchdogAttemptsInEpisode - 1` is clamped to its last
 *  index. */
const RECONNECT_BACKOFF_STEPS_MS = [10, 20, 40, 60].map(minutes => minutes * 60_000)

/**
 * Single place to flip: whether the reconnect watchdog is allowed to
 * actually call `sync.reconnect` when its conditions are met. Defaults to
 * `false` — detection, episode recording, and backoff bookkeeping all stay
 * fully live regardless of this flag, and when suppressed the watchdog
 * records that it WOULD have fired (`recordStallReconnectWouldHaveFired`),
 * so the dump still shows what an enabled watchdog would have done.
 *
 * Rationale: the automatic reconnect's BENEFIT is unproven — no recorded
 * episode has yet shown a stall clearing BECAUSE a watchdog reconnect fired,
 * since this instrumentation predates having any episodes at all — while its
 * COSTS are now measured (an extra `connect()`/`disconnect()` cycle per
 * backoff step, cross-tab lock contention). It ships observe-only until
 * recorded episodes justify enabling it. Use
 * {@link __setReconnectWatchdogEnabledForTest} to flip this in a test; do
 * NOT gate on a separate copy of this decision anywhere else in this module.
 */
export let RECONNECT_WATCHDOG_ENABLED = false

/** Test-only: flip {@link RECONNECT_WATCHDOG_ENABLED}. Reset to `false`
 *  (the production default) by {@link __resetDbForensicsHooksForTest}. */
export const __setReconnectWatchdogEnabledForTest = (enabled: boolean): void => {
  RECONNECT_WATCHDOG_ENABLED = enabled
}

// Reconnect-watchdog state — single active-user, reset per-arm/re-arm and on
// stall-clear.
let watchdogAttemptsInEpisode = 0
let watchdogLastAttemptAt: number | null = null

// Cross-tab leader election around the RECONNECT ITSELF (not sampling):
// `enableMultiTabs: true` (repoProvider.ts) means every open tab of this
// origin shares one underlying PowerSync sync worker, but
// `watchdogAttemptsInEpisode`/`watchdogLastAttemptAt` above are module-local
// per TAB — so two tabs hitting the same sustained stall independently
// reconnect on the same schedule, and one tab's fresh `connect()` can be torn
// down by the other tab's `disconnect()` moments later. `navigator.locks`
// (Web Locks API) is a cheap, origin-scoped exclusive lock shared across
// tabs: whichever tab acquires it this round does the reconnect; a tab that
// can't skips (recorded via `recordStallReconnectSkipped`, not a silent
// no-op) rather than piling onto the same recovery attempt. Feature-detected:
// an environment without `navigator.locks` runs unguarded — no cross-tab
// coordination at all is worse than a possible duplicate attempt.
const RECONNECT_LOCK_NAME = 'km-sync-reconnect-watchdog'

interface LocksLikeNavigator {
  locks?: {
    request: (
      name: string,
      options: { mode: 'exclusive'; ifAvailable: true },
      callback: (lock: unknown) => Promise<void>,
    ) => Promise<void>
  }
}

/** Run `fn` holding the cross-tab reconnect lock. Resolves `true` if `fn` ran
 *  (lock acquired, or there's no `navigator.locks` to guard with), `false` if
 *  another tab holds the lock this round (`fn` was NOT run) OR the Web Locks
 *  API itself rejected (browser quirk / non-fully-active document) — treated
 *  the same as "did not run" since either way `fn` never executed. Without
 *  this try/catch a rejection from `locks.request` would propagate straight
 *  out of the watchdog's own single-flight chain (see `enqueueWatchdog`) as
 *  an unhandled rejection rather than a recorded, benign skip. */
const runGuardedReconnect = async (fn: () => Promise<void>): Promise<boolean> => {
  const locks = typeof navigator !== 'undefined' ? (navigator as LocksLikeNavigator).locks : undefined
  if (!locks) {
    await fn()
    return true
  }
  let ran = false
  try {
    await locks.request(RECONNECT_LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (lock === null) return // another tab holds the lock this round — skip
      ran = true
      await fn()
    })
  } catch (err) {
    console.warn('[db-forensics] runGuardedReconnect: navigator.locks.request rejected', err)
    return false
  }
  return ran
}

/**
 * Best-effort auto-recovery for a sustained sync stall — the lever missing
 * in the 2026-08-13 incident (22 blocks stuck 16.3h; four restarts that
 * didn't drain the queue; there was no lever, automatic or manual, to
 * recover short of restart, and restart demonstrably didn't work). Fires
 * `sync.reconnect` once per stall episode, then backs off along
 * `RECONNECT_BACKOFF_STEPS_MS` so a persistent stall doesn't hammer the
 * connector — never faster than the schedule, no matter how many samples
 * fire while stalled. Gated off by default — see
 * {@link RECONNECT_WATCHDOG_ENABLED}.
 *
 * `queueAgeCondition` (the caller's own name for its argument may vary, but
 * the CONTRACT is fixed) must be the queue-age half ONLY — `queueOld` from
 * `computeSyncStall`, ANDed with "held for at least 2 consecutive known
 * samples" — never the caller's broader `stall` verdict. `stall` also goes
 * true on `syncStale` alone ("no checkpoint recently"), which on a quiet
 * single-user account with nothing queued to upload is the ordinary healthy
 * steady state, not a problem a reconnect should react to — and it has no
 * dwell requirement at all (a single sample can trip it). Reconnecting on
 * that would fire on every quiet account roughly `SYNC_STALL_THRESHOLD_MS`
 * after boot, for no reason. The queue-age condition is what's actually
 * "something is stuck" — a non-empty queue not moving — and requiring 2
 * consecutive samples before acting is a small extra debounce against a
 * single noisy/borderline sample.
 *
 * Records the attempt (count + timestamp) onto the CURRENTLY OPEN stall
 * episode via `recordStallReconnectAttempt` — a diagnostic side effect of
 * firing, kept apart from the POLICY of whether/when to fire (which lives
 * entirely in this function) even though both this function and its caller
 * read the same sample: recording is a diagnostic, reconnecting is an
 * action. A skip (another tab owns this round — see `runGuardedReconnect`)
 * is recorded too, via `recordStallReconnectSkipped`, WITHOUT advancing
 * `watchdogAttemptsInEpisode`/`watchdogLastAttemptAt` — this tab didn't
 * actually attempt anything, so it stays eligible to try again on the very
 * next sample rather than waiting out a backoff step it never used.
 *
 * Never throws: a failing `reconnect` must not break the sampler that calls
 * this every minute (`recordStallReconnectAttempt`/`recordStallReconnectSkipped`
 * are already self-guarded). Exactly one `console.warn` per attempt/skip/
 * would-have-fired.
 */
const runReconnectWatchdog = async (
  userId: string,
  queueAgeCondition: boolean,
  now: number,
  episodeKey: string | null,
  reconnect: (userId: string) => Promise<void>,
  forensics: DbForensics,
): Promise<void> => {
  if (!queueAgeCondition) {
    // Queue drained, never stalled, or syncStale-only (no queue-age problem)
    // — the NEXT episode starts its own backoff fresh, per "reset the
    // backoff when the queue-age condition clears".
    watchdogAttemptsInEpisode = 0
    watchdogLastAttemptAt = null
    return
  }

  if (watchdogAttemptsInEpisode > 0) {
    const requiredGapMs = RECONNECT_BACKOFF_STEPS_MS[
      Math.min(watchdogAttemptsInEpisode - 1, RECONNECT_BACKOFF_STEPS_MS.length - 1)
    ]
    if (watchdogLastAttemptAt !== null && now - watchdogLastAttemptAt < requiredGapMs) {
      return // inside the backoff window — do not reconnect more often than the schedule
    }
  }

  if (!RECONNECT_WATCHDOG_ENABLED) {
    watchdogLastAttemptAt = now
    watchdogAttemptsInEpisode += 1
    console.warn(
      `[db-forensics] sync watchdog: sustained stall for ${userId} — WOULD attempt sync.reconnect ` +
      `(attempt #${watchdogAttemptsInEpisode} this episode) but RECONNECT_WATCHDOG_ENABLED is false`,
    )
    await forensics.recordStallReconnectWouldHaveFired(episodeKey, now)
    return
  }

  const acquired = await runGuardedReconnect(async () => {
    watchdogLastAttemptAt = now
    watchdogAttemptsInEpisode += 1

    console.warn(
      `[db-forensics] sync watchdog: sustained stall for ${userId} — attempting sync.reconnect ` +
      `(attempt #${watchdogAttemptsInEpisode} this episode)`,
    )

    await forensics.recordStallReconnectAttempt(episodeKey, now)

    try {
      await reconnect(userId)
    } catch {
      // Best-effort: a failing reconnect must not break the sampler. The
      // console.warn above already recorded that an attempt happened (one per
      // attempt, per spec — no second warn here); whether it helped shows up
      // in the next sample (stall clears or not) and in the episode record.
    }
  })

  if (!acquired) {
    console.warn(
      `[db-forensics] sync watchdog: reconnect for ${userId} skipped this round — ` +
      'another tab holds the cross-tab lock',
    )
    await forensics.recordStallReconnectSkipped(episodeKey)
  }
}

// The watchdog's own single-flight chain — SEPARATE from `sampleChain`
// below. `sampleSyncHealth` used to `await runReconnectWatchdog(...)`
// directly, which meant a slow or hung `reconnect()` call stopped
// sync-health SAMPLING for the rest of the session (the sampler and the
// watchdog shared one serialized chain) — exactly when a reader most needs
// fresh samples, and it collapsed the `connected:false → connecting →
// connected` transitions that answer "did the reconnect actually work" into
// a single delayed sample. `enqueueWatchdog` lets the watchdog run on its
// own chain: `sampleSyncHealth` fires it and moves on immediately: the
// episode record (recordStallReconnectAttempt/recordStallReconnectSkipped/
// recordStallReconnectWouldHaveFired) already carries the attempt and
// timestamp, so the outcome still lands — just via the episode, not by
// blocking the next sample.
let watchdogChain: Promise<void> = Promise.resolve()
const enqueueWatchdog = (run: () => Promise<void>): void => {
  watchdogChain = watchdogChain.then(run, run)
}

const sampleSyncHealth = async (
  db: SyncHealthDb,
  userId: string,
  reconnect: (userId: string) => Promise<void>,
  forensics: DbForensics,
  generation: number,
): Promise<void> => {
  const status = db.currentStatus
  // The five queries are independent — run them concurrently, same reasoning
  // as runHealthCommand (healthCommand.ts).
  const [pendingBlocks, rejected, materializing, pendingRows, edge] = await Promise.all([
    safeCount(db, uploadQueuePreviewCountSql),
    safeCount(db, rejectedQueueCountSql),
    safeCount(db, materializeQueueCountSql),
    safeCount(db, uploadQueueRowCountSql),
    safeQueueEdge(db),
  ])

  // Generation guard (item 9): a teardown/re-arm (`stopSyncHealthWatch`,
  // including `watchSyncHealth`'s own internal re-arm) may have happened
  // while the awaits above were in flight — bail before touching ANY module
  // global, and before recording anything or calling `reconnect` under
  // what's now a DIFFERENT user's watch. See `watchGeneration`'s doc.
  if (generation !== watchGeneration) return

  const lastSyncedAt = toEpochMs(status?.lastSyncedAt)
  const now = Date.now()

  const loKnown = edge !== null
  const lo = edge?.lo ?? null

  const { stall, pendingSince, progressed, queueOld } = computeSyncStall({
    lo,
    loKnown,
    lastLo: syncLastLo,
    lastSyncedAt,
    pendingSince: syncPendingSince,
    armedAt: syncArmedAt,
    now,
    previousStall: syncLastStallVerdict,
  })
  syncPendingSince = pendingSince
  syncLastStallVerdict = stall
  // Only remember a SUCCESSFUL edge query for the next sample's progress
  // check — same "unknown must not erase known state" discipline as
  // `pendingSince`.
  if (loKnown) syncLastLo = lo
  // The watchdog's own eligibility counter (item 7): advance/reset only on a
  // KNOWN sample, leave unchanged on an unknown one (see the field's doc).
  if (loKnown) {
    consecutiveQueueOldSamples = queueOld ? consecutiveQueueOldSamples + 1 : 0
  }

  const uploading = Boolean(flowField(status, 'uploading'))
  const downloading = Boolean(flowField(status, 'downloading'))
  // Fold the notification-time latch (item 4 — see its doc above) into this
  // sample, then reset it: this sample has now "consumed" whatever toggled
  // since the last one. If `uploading`/`downloading` are themselves still
  // true right now, the OR below (and any future notification) keeps
  // reflecting that regardless of the reset.
  const uploadingSeen = latchedUploadingSeen || uploading
  const downloadingSeen = latchedDownloadingSeen || downloading
  latchedUploadingSeen = false
  latchedDownloadingSeen = false

  const sample = {
    t: now,
    userId,
    connected: Boolean(status?.connected),
    connecting: Boolean(status?.connecting),
    hasSynced: status?.hasSynced ?? null,
    lastSyncedAt,
    uploading,
    downloading,
    uploadingSeen,
    downloadingSeen,
    pendingRows,
    pendingBlocks,
    pendingSinceT: syncPendingSince,
    rejected,
    materializing,
    uploadError: errorMessageOf(flowField(status, 'uploadError')),
    downloadError: errorMessageOf(flowField(status, 'downloadError')),
    stall,
  }

  const wasOpen = openStallEpisodeKey !== null
  if (stall && !wasOpen) {
    const syncAgeMin = lastSyncedAt !== null ? Math.round((now - lastSyncedAt) / 60_000) : null
    const queueAgeMin = syncPendingSince !== null ? Math.round((now - syncPendingSince) / 60_000) : null
    console.warn(
      `[db-forensics] sync stall detected: ${pendingBlocks} pending block(s), ` +
      `queue non-empty for ${queueAgeMin}min, last synced ${syncAgeMin ?? 'never'}min ago`,
    )
    openStallEpisodeKey = await forensics.recordStallEpisode(sample)
  } else if (wasOpen) {
    // OR this sample's seen-flags into the still-open episode BEFORE
    // potentially closing it below — see StallEpisode's doc on why these
    // must be maintained across the whole episode, not just its onset.
    await forensics.recordStallSeenFlags(openStallEpisodeKey, sample.uploadingSeen, sample.downloadingSeen)

    if (loKnown && lo === null) {
      // The queue actually drained to empty — the ONLY condition that
      // closes a durable episode (item 2). Deliberately NOT `!stall`: a
      // dribbling queue can make `stall` blip false for a sample or two
      // (pendingSince resetting on progress) while the queue is still very
      // much non-empty, and closing on that fabricates a resolution per
      // dribble — the proven 2026-08-13-aftermath failure mode.
      await forensics.closeStallEpisode(openStallEpisodeKey, {
        clearedAt: now,
        connected: sample.connected,
        lastSyncedAt: sample.lastSyncedAt,
        pendingBlocks: sample.pendingBlocks,
        rejected: sample.rejected,
        pendingRows: sample.pendingRows,
        uploadError: sample.uploadError,
        downloadError: sample.downloadError,
      })
      openStallEpisodeKey = null
    } else if (progressed) {
      // Real forward progress (`lo` advanced) while the queue is STILL
      // non-empty — record it on the episode instead of closing (item 2):
      // this is what tells "wedged, never moving" apart from "draining
      // unattended, just slower than the threshold" without fabricating a
      // resolution.
      await forensics.recordStallProgress(openStallEpisodeKey, { at: now, pendingBlocks: sample.pendingBlocks })
    }
  }

  await forensics.recordSyncSample(sample)

  // Recovery watchdog: fired on its OWN single-flight chain (item 8), not
  // awaited here — a slow/hung reconnect must not stall sync-health
  // SAMPLING for the rest of the session (see `enqueueWatchdog`'s doc). Acts
  // only on the queue-age condition, held for 2+ consecutive known samples
  // (item 7) — never on `stall` alone, which also goes true on `syncStale`
  // alone (see `runReconnectWatchdog`'s doc).
  const watchdogCondition = queueOld && consecutiveQueueOldSamples >= 2
  const watchdogEpisodeKey = openStallEpisodeKey
  enqueueWatchdog(() =>
    runReconnectWatchdog(userId, watchdogCondition, now, watchdogEpisodeKey, reconnect, forensics),
  )
}

// Concurrent samples must not interleave: two `sampleSyncHealth` calls racing
// across the `await recordStallEpisode`/`closeStallEpisode` awaits inside it
// can each read `openStallEpisodeKey` from BEFORE the other's write lands —
// e.g. a CLEARING sample can read `openStallEpisodeKey === null` (an
// in-flight OPENING sample hasn't finished assigning it yet), take neither
// branch, and do nothing; the opening sample then finishes and assigns the
// key, leaving a "stalled but never recorded as resolving" episode open even
// though the queue actually drained in between. Both
// `statusChanged` and the interval timer fire `sampleSyncHealth`
// fire-and-forget (`void sampleSyncHealth(...)` below), so this is reachable
// in practice: PowerSync also emits `statusChanged` for download-progress
// updates during an initial sync, so rapid-fire notifications launching
// overlapping samples is a normal occurrence, not an edge case.
//
// Fix: serialize on a module-level chain, same idiom as
// `DbForensics.enqueue`/`enqueueSync`. Unlike that idiom, this ALSO collapses
// a pending re-run rather than stacking one per call: every queued call reads
// LIVE state at run time (`db.currentStatus`, fresh counts), so a second,
// third, ... call queued behind the same in-flight one would just repeat the
// same work for no new information — and a single slow sample (a slow count
// query, or a `reconnect()` the watchdog awaits) must not let arbitrarily
// many statusChanged/interval ticks pile up behind it.
let sampleChain: Promise<void> = Promise.resolve()
let samplePendingRerun = false

const enqueueSample = (run: () => Promise<void>): void => {
  if (samplePendingRerun) return // one is already queued behind the in-flight sample — coalesce
  samplePendingRerun = true
  const runNext = () => {
    samplePendingRerun = false
    return run()
  }
  sampleChain = sampleChain.then(runNext, runNext)
}

/**
 * Tear down the sync-health watcher (listener + interval + all per-episode
 * state) without arming a new one. Call when the active session switches to
 * local-only IN-PAGE (no reload) — `ensurePowerSyncReady`'s `useRemoteSync`
 * early return happens BEFORE the `watchSyncHealth` call below (that
 * position is load-bearing and pinned by a test: sampling a local-only
 * session would record every sample as a false stall, since the queue is
 * local-only and never drains to a server, and the watchdog would try to
 * `connect()` a session that deliberately never makes a remote request), so
 * without an explicit teardown call the PREVIOUS remote session's watcher is
 * simply never disposed: it keeps sampling the OLD (now-orphaned) db on its
 * own timer/listener and filing samples into the still-active ring under the
 * new, local-only session. Safe to call when nothing is being watched
 * (no-op). Also used internally by `watchSyncHealth`'s own re-arm and by
 * `__resetDbForensicsHooksForTest`, so there is exactly one teardown path.
 *
 * Bumps {@link watchGeneration} UNCONDITIONALLY (even when nothing was being
 * watched) — this is the item-9 fix: any `sampleSyncHealth` call already in
 * flight from whatever WAS armed compares its own captured generation
 * against the live value after it resumes, and bails before touching any of
 * the module globals reset below.
 */
export const stopSyncHealthWatch = (): void => {
  watchGeneration += 1
  disposeSyncWatch?.()
  disposeSyncWatch = null
  if (syncIntervalId !== null) {
    clearInterval(syncIntervalId)
    syncIntervalId = null
  }
  syncWatchedUserId = null
  syncArmedAt = 0
  syncPendingSince = null
  syncLastLo = null
  syncLastStallVerdict = false
  openStallEpisodeKey = null
  consecutiveQueueOldSamples = 0
  latchedUploadingSeen = false
  latchedDownloadingSeen = false
  watchdogAttemptsInEpisode = 0
  watchdogLastAttemptAt = null
  sampleChain = Promise.resolve()
  samplePendingRerun = false
  watchdogChain = Promise.resolve()
}

/**
 * Watch the PowerSync connection for sync-health breadcrumbs — the record
 * that was MISSING in the 2026-08-13 iPad incident (22 blocks stuck in
 * `ps_crud` for 16.3 hours; four app restarts didn't drain it; whether
 * downloads were even working was unanswerable after the fact). Samples on
 * arm, on every `statusChanged`, and on a `SYNC_SAMPLE_INTERVAL_MS` timer —
 * cheap because `recordSyncSample` coalesces identical consecutive samples,
 * so a long stall costs one ring slot, not thousands.
 *
 * Re-arms per user, same shape as {@link watchForRuntimeCorruption}: on an
 * in-page account switch it disposes the previous listener + timer (via
 * {@link stopSyncHealthWatch}, which also bumps the generation token — see
 * its doc) and rebinds to the new user, re-arming all per-episode state too.
 *
 * `reconnect` is the `sync.reconnect` primitive (`reconnectPowerSync` in
 * repoProvider.ts), injected rather than imported so this module never
 * depends on repoProvider (which itself imports this module to arm the
 * watcher) — the caller wires the two together.
 */
export const watchSyncHealth = (
  db: SyncHealthDb,
  userId: string,
  reconnect: (userId: string) => Promise<void>,
  forensics: DbForensics = dbForensics,
): void => {
  if (syncWatchedUserId === userId) return
  stopSyncHealthWatch() // bumps watchGeneration
  syncWatchedUserId = userId
  syncArmedAt = Date.now()
  // Captured ONCE for the life of this arm — see `watchGeneration`'s doc.
  // Every sample this arm schedules (immediate + statusChanged + interval)
  // threads this SAME value through, not a live re-read, so a sample that's
  // already in flight when a later teardown bumps `watchGeneration` still
  // compares against the value that was current when IT was scheduled.
  const generation = watchGeneration

  const sample = () => enqueueSample(() => sampleSyncHealth(db, userId, reconnect, forensics, generation))

  // Latches uploading/downloading at NOTIFICATION time, off the delivered
  // status payload — see `latchedUploadingSeen`'s doc for why this can't
  // just re-read `db.currentStatus` later inside the (possibly
  // throttled/coalesced) sample itself.
  const onStatusChanged = (delivered: SyncStatusLike): void => {
    if (flowField(delivered, 'uploading')) latchedUploadingSeen = true
    if (flowField(delivered, 'downloading')) latchedDownloadingSeen = true
    sample()
  }

  sample() // once, immediately — don't wait a full interval to see the current state
  disposeSyncWatch = typeof db.registerListener === 'function'
    ? db.registerListener({ statusChanged: onStatusChanged })
    : null
  syncIntervalId = setInterval(sample, SYNC_SAMPLE_INTERVAL_MS)
}

/** Test-only: reset the once-per-process guards + per-user watcher state. */
export const __resetDbForensicsHooksForTest = (): void => {
  sessionRecorded = false
  lifecycleInstalled = false
  disposeWatch?.()
  disposeWatch = null
  watchedUserId = null
  runtimeCorruptionCaptured = false

  stopSyncHealthWatch()
  __setReconnectWatchdogEnabledForTest(false) // production default
}

/**
 * Register global lifecycle listeners that feed the current session's breadcrumb
 * log + clean-shutdown flag, and expose a retrieval hook on
 * `window.__omniliner.forensics` (`dump()` / `download()`) so the recorded
 * breadcrumbs + corruption snapshots can be pulled over the remote inspector or
 * downloaded next incident. `pagehide` marks a clean exit; `pageshow`/`resume`
 * un-mark it (the session is live again — avoids a bfcache false-negative).
 * Idempotent; call once at app startup.
 */
export const installDbForensicsLifecycle = (forensics: DbForensics = dbForensics): void => {
  if (lifecycleInstalled || typeof window === 'undefined') return
  lifecycleInstalled = true
  document.addEventListener('visibilitychange', () => {
    void forensics.recordLifecycleEvent(`visibility:${document.visibilityState}`)
  })
  window.addEventListener('freeze', () => void forensics.recordLifecycleEvent('freeze'))
  window.addEventListener('pagehide', () => void forensics.markCleanShutdown())
  // pageshow/resume: the session is live again, so un-mark clean. This can also
  // fire after a clean nav-away+freeze without a bfcache restore, logging a
  // benign `unclean` — but only ever while hidden, so it lands in the benign
  // `unclean+hidden` bucket, not the suspicious `unclean+visible` one we watch.
  window.addEventListener('pageshow', () => void forensics.clearCleanShutdown())
  window.addEventListener('resume', () => void forensics.clearCleanShutdown())

  // Retrieval hook, shared with the `__omniliner` namespace (see
  // metricsConsoleHook). Available even in the bootstrap error fallback (no
  // Repo), so a corrupt-DB session can still hand over its forensics.
  const ns = (window.__omniliner ?? {}) as Record<string, unknown> & {
    forensics?: OmnilinerForensicsApi
  }
  ns.forensics = {
    dump: () => forensics.exportAll(),
    download: async () => downloadJson('db-forensics.json', await forensics.exportAll()),
  }
  window.__omniliner = ns as Window['__omniliner']
}

interface OmnilinerForensicsApi {
  /** Every forensic record (sessions, unclean archives, snapshots). */
  dump: () => Promise<Record<string, unknown>>
  /** Download the dump as `db-forensics.json`. */
  download: () => Promise<void>
}

const downloadJson = (filename: string, data: unknown): void => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
