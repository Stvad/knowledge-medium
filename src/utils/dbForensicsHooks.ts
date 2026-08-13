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

const sampleSyncHealth = async (db: SyncHealthDb, forensics: DbForensics): Promise<void> => {
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

  const syncStale = lastSyncedAt !== null && now - lastSyncedAt > SYNC_STALL_THRESHOLD_MS
  const queueOld = syncPendingSince !== null && now - syncPendingSince > SYNC_STALL_THRESHOLD_MS
  const stall = pendingBlocks !== null && pendingBlocks > 0 && (syncStale || queueOld)

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
 */
export const watchSyncHealth = (
  db: SyncHealthDb,
  userId: string,
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

  const sample = () => void sampleSyncHealth(db, forensics)

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
