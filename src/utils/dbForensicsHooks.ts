/**
 * Wiring between the app boot/lifecycle and the out-of-band {@link dbForensics}
 * recorder. Kept separate from `dbForensics` (pure store) and from
 * `repoProvider` (which just calls these) so the glue — the per-user watcher,
 * the lifecycle listeners, the retrieval hook — lives in one place.
 */

import { dbForensics, type DbForensics } from '@/utils/dbForensics.js'
import { isLocalDbCorruptionError, isRuntimeDbCorruptionError } from '@/utils/localDbCorruption.js'
import { reportRuntimeLocalDbCorruption } from '@/data/localDbCorruptionSignal.js'
import {
  materializeQueueCountSql,
  rejectedQueueCountSql,
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

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

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
    sql: { message: messageOf(error) },
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
        sql: { downloadError: messageOf(err) },
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
  const msg = messageOf(error)
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
// Once-per-stall-episode console.warn latch: set on the not-stalled→stalled
// transition, cleared the moment it's no longer stalled (so the NEXT episode
// gets its own console line too), and reset on a fresh `watchSyncHealth` arm.
let syncStallWarned = false
// Epoch ms the CURRENT unbroken run of `pendingBlocks > 0` began, or null when
// the queue is empty. Independent of `lastSyncedAt`: `lastSyncedAt` advances
// on every DOWNLOAD checkpoint, so it stays "fresh" even when uploads are
// wedged and downloads keep working — one of the two live hypotheses for the
// 2026-08-13 incident, and a stall condition keyed only on `lastSyncedAt`
// can't see it. This clock is the second, independent signal: how long has
// the queue itself been non-empty. LIMITATION: it's in-memory, not persisted,
// so a stall spanning a restart re-arms each boot and only flags again
// ~SYNC_STALL_THRESHOLD_MS into the new session — acceptable (the incident's
// four restarts didn't drain the queue either way; the ring + stall-episode
// log still show the pre-restart state via `recordSessionStart`'s archive).
let syncPendingSince: number | null = null
// The currently-open stall episode's store key (see dbForensics.ts
// recordStallEpisode/closeStallEpisode), or null when nothing is open. Tracked
// here, next to `syncStallWarned`, because the store has no notion of "the
// current" episode — only the watcher knows which one is still in flight.
let openStallEpisodeKey: string | null = null

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
 * The queue-age half (`queueOld`) is independently load-bearing, not just
 * belt-and-suspenders: `lastSyncedAt` advances on every DOWNLOAD checkpoint,
 * so it stays "fresh" even when uploads are wedged and downloads keep
 * working — one of the two live hypotheses for the 2026-08-13 incident. A
 * predicate keyed only on `lastSyncedAt` can't see that split at all.
 */
export const computeSyncStall = (params: {
  pendingBlocks: number | null
  lastSyncedAt: number | null
  pendingSince: number | null
  now: number
}): boolean => {
  const syncStale = params.lastSyncedAt !== null && params.now - params.lastSyncedAt > SYNC_STALL_THRESHOLD_MS
  const queueOld = params.pendingSince !== null && params.now - params.pendingSince > SYNC_STALL_THRESHOLD_MS
  return params.pendingBlocks !== null && params.pendingBlocks > 0 && (syncStale || queueOld)
}

/** Reconnect-watchdog backoff ladder (minutes → ms): 10 → 20 → 40, capped at
 *  60 (~1h). Index `i` is the gap required after the `(i+1)`-th attempt in
 *  the current stall episode before the `(i+2)`-th is allowed — see
 *  `runReconnectWatchdog`. Once the episode has escalated past the last
 *  step, every subsequent attempt reuses that step (the cap): the array
 *  never grows and `watchdogAttemptsInEpisode - 1` is clamped to its last
 *  index. */
const RECONNECT_BACKOFF_STEPS_MS = [10, 20, 40, 60].map(minutes => minutes * 60_000)

// Reconnect-watchdog state — single active-user, reset per-arm/re-arm and on
// stall-clear, same convention as `syncStallWarned` et al. above.
let watchdogAttemptsInEpisode = 0
let watchdogLastAttemptAt: number | null = null

/**
 * Best-effort auto-recovery for a sustained sync stall — the lever missing
 * in the 2026-08-13 incident (22 blocks stuck 16.3h; four restarts that
 * didn't drain the queue; there was no lever, automatic or manual, to
 * recover short of restart, and restart demonstrably didn't work). Fires
 * `sync.reconnect` once per stall episode, then backs off along
 * `RECONNECT_BACKOFF_STEPS_MS` so a persistent stall doesn't hammer the
 * connector — never faster than the schedule, no matter how many samples
 * fire while stalled.
 *
 * Deliberately keyed off the SAME `stall` boolean the caller already
 * computed via `computeSyncStall` (see that function's doc for why there is
 * exactly one definition), not its own connection-state check: an offline
 * device (`connected: false, connecting: false`) with a non-empty queue
 * trips the identical predicate and gets the identical schedule. There is no
 * special "retry faster because offline" path — that would be the spin this
 * guards against — and no suppression either, which would leave a
 * dropped-connection stall unrecovered (a reconnect is cheap and is exactly
 * what a dropped connection needs).
 *
 * Records the attempt (count + timestamp) onto the CURRENTLY OPEN stall
 * episode via `recordStallReconnectAttempt` — a diagnostic side effect of
 * firing, kept apart from the POLICY of whether/when to fire (which lives
 * entirely in this function) even though both this function and its caller
 * read the same sample: recording is a diagnostic, reconnecting is an
 * action.
 *
 * Never throws: a failing `reconnect` must not break the sampler that calls
 * this every minute (`recordStallReconnectAttempt` is already self-guarded).
 * Exactly one `console.warn` per attempt.
 */
const runReconnectWatchdog = async (
  userId: string,
  stall: boolean,
  now: number,
  episodeKey: string | null,
  reconnect: (userId: string) => Promise<void>,
  forensics: DbForensics,
): Promise<void> => {
  if (!stall) {
    // Queue drained (or never stalled) — the NEXT episode starts its own
    // backoff fresh, per "reset the backoff when the queue drains".
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
}

const sampleSyncHealth = async (
  db: SyncHealthDb,
  userId: string,
  reconnect: (userId: string) => Promise<void>,
  forensics: DbForensics,
): Promise<void> => {
  const status = db.currentStatus
  // The four counts are independent — run them concurrently, same reasoning
  // as runHealthCommand (healthCommand.ts).
  const [pendingBlocks, rejected, materializing, pendingRows] = await Promise.all([
    safeCount(db, uploadQueuePreviewCountSql),
    safeCount(db, rejectedQueueCountSql),
    safeCount(db, materializeQueueCountSql),
    safeCount(db, uploadQueueRowCountSql),
  ])

  const lastSyncedAt = toEpochMs(status?.lastSyncedAt)
  const now = Date.now()

  // `pendingBlocks === null` means the COUNT QUERY FAILED, not an empty
  // queue — leave the clock untouched rather than reset it (a transient query
  // failure must not erase how long a real stall has been running).
  if (pendingBlocks !== null) {
    if (pendingBlocks > 0) {
      syncPendingSince ??= now
    } else {
      syncPendingSince = null
    }
  }

  const stall = computeSyncStall({ pendingBlocks, lastSyncedAt, pendingSince: syncPendingSince, now })

  const sample = {
    t: now,
    connected: Boolean(status?.connected),
    connecting: Boolean(status?.connecting),
    hasSynced: status?.hasSynced ?? null,
    lastSyncedAt,
    uploading: Boolean(flowField(status, 'uploading')),
    downloading: Boolean(flowField(status, 'downloading')),
    pendingRows,
    pendingBlocks,
    pendingSinceT: syncPendingSince,
    rejected,
    materializing,
    uploadError: errorMessageOf(flowField(status, 'uploadError')),
    downloadError: errorMessageOf(flowField(status, 'downloadError')),
    stall,
  }

  if (stall && !syncStallWarned) {
    syncStallWarned = true
    const syncAgeMin = lastSyncedAt !== null ? Math.round((now - lastSyncedAt) / 60_000) : null
    const queueAgeMin = syncPendingSince !== null ? Math.round((now - syncPendingSince) / 60_000) : null
    console.warn(
      `[db-forensics] sync stall detected: ${pendingBlocks} pending block(s), ` +
      `queue non-empty for ${queueAgeMin}min, last synced ${syncAgeMin ?? 'never'}min ago`,
    )
    openStallEpisodeKey = await forensics.recordStallEpisode(sample)
  } else if (!stall && syncStallWarned) {
    syncStallWarned = false
    await forensics.closeStallEpisode(openStallEpisodeKey, {
      clearedAt: now,
      connected: sample.connected,
      lastSyncedAt: sample.lastSyncedAt,
      pendingBlocks: sample.pendingBlocks,
    })
    openStallEpisodeKey = null
  }

  await forensics.recordSyncSample(sample)

  // Recovery watchdog: reads the SAME `stall`/`openStallEpisodeKey` this
  // sample just computed/recorded, but its firing policy is independent of
  // the recording above — see `runReconnectWatchdog`'s doc.
  await runReconnectWatchdog(userId, stall, now, openStallEpisodeKey, reconnect, forensics)
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
 * in-page account switch it disposes the previous listener + timer and
 * rebinds to the new user, re-arming the stall-warning latch too.
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
  disposeSyncWatch?.()
  disposeSyncWatch = null
  if (syncIntervalId !== null) {
    clearInterval(syncIntervalId)
    syncIntervalId = null
  }
  syncWatchedUserId = userId
  syncStallWarned = false
  syncPendingSince = null
  openStallEpisodeKey = null
  watchdogAttemptsInEpisode = 0
  watchdogLastAttemptAt = null

  const sample = () => void sampleSyncHealth(db, userId, reconnect, forensics)

  sample() // once, immediately — don't wait a full interval to see the current state
  disposeSyncWatch = typeof db.registerListener === 'function'
    ? db.registerListener({ statusChanged: sample })
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

  disposeSyncWatch?.()
  disposeSyncWatch = null
  if (syncIntervalId !== null) {
    clearInterval(syncIntervalId)
    syncIntervalId = null
  }
  syncWatchedUserId = null
  syncStallWarned = false
  syncPendingSince = null
  openStallEpisodeKey = null
  watchdogAttemptsInEpisode = 0
  watchdogLastAttemptAt = null
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
