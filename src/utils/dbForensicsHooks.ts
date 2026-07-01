/**
 * Wiring between the app boot/lifecycle and the out-of-band {@link dbForensics}
 * recorder. Kept separate from `dbForensics` (pure store) and from
 * `repoProvider` (which just calls these) so the glue — once-guards, the
 * broadened corruption matcher, the lifecycle listeners — lives in one place.
 */

import { dbForensics, type DbForensics } from '@/utils/dbForensics.js'
import { isLocalDbCorruptionError } from '@/utils/localDbCorruption.js'
import { scheduleIdle } from '@/utils/scheduleIdle.js'

/**
 * Broader than `isLocalDbCorruptionError` ON PURPOSE. That function gates a
 * DESTRUCTIVE reset, so it only matches narrow, unambiguous open-time SQLite
 * phrasings. Forensic capture is READ-ONLY (it just records a snapshot), so it
 * should also fire on the RUNTIME sync-apply phrasing the strict matcher omits —
 * `powersync_control: internal SQLite call returned CORRUPT` — which is exactly
 * the class the strict matcher (and the #281 recovery UI) currently misses.
 */
export const looksLikeDbCorruptionForForensics = (error: unknown): boolean => {
  if (isLocalDbCorruptionError(error)) return true
  const msg = error instanceof Error ? error.message : String(error ?? '')
  return /returned corrupt|powersync_control|sqlite_corrupt/i.test(msg)
}

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
let runtimeWatchInstalled = false
let runtimeCorruptionCaptured = false
let lifecycleInstalled = false

/**
 * Record a new forensic session (unclean-shutdown detection) and schedule an
 * idle zero-page scan. Once per page load — later `ensurePowerSyncReady` calls
 * (re-render / account switch) are no-ops. Best-effort; never throws.
 */
export const recordForensicSessionStart = (
  userId: string,
  dbFilename: string,
  forensics: DbForensics = dbForensics,
): void => {
  if (sessionRecorded) return
  sessionRecorded = true
  void (async () => {
    await forensics.recordSessionStart({ userId, dbFilename })
    scheduleIdle(() => void forensics.logScan({ userId, dbFilename }))
  })()
}

/** Capture a forensic snapshot on a DB-OPEN corruption, before recovery. */
export const captureDbOpenCorruption = (
  userId: string,
  dbFilename: string,
  error: unknown,
  forensics: DbForensics = dbForensics,
): void => {
  if (!looksLikeDbCorruptionForForensics(error)) return
  void forensics.captureCorruptionSnapshot({
    userId,
    dbFilename,
    reason: 'db-open-corrupt',
    sql: { message: error instanceof Error ? error.message : String(error) },
  })
}

/**
 * Watch the PowerSync connection for a RUNTIME sync-apply corruption
 * (`downloadError`) and capture a snapshot the first time one appears. This is
 * the class the DB-open detector never sees (connect isn't awaited). Read-only:
 * it records forensics, it does NOT trigger recovery (that's a separate #281
 * follow-up). Installed once per process.
 */
export const watchForRuntimeCorruption = (
  db: CorruptionWatchDb,
  userId: string,
  dbFilename: string,
  forensics: DbForensics = dbForensics,
): void => {
  if (runtimeWatchInstalled) return
  runtimeWatchInstalled = true
  const check = (status: DownloadErrorStatus | undefined): void => {
    if (runtimeCorruptionCaptured) return
    const err = downloadErrorOf(status)
    if (err === undefined || err === null || !looksLikeDbCorruptionForForensics(err)) return
    runtimeCorruptionCaptured = true
    void forensics.captureCorruptionSnapshot({
      userId,
      dbFilename,
      reason: 'runtime-sync-corrupt',
      sql: { downloadError: err instanceof Error ? err.message : String(err) },
    })
  }
  check(db.currentStatus)
  if (typeof db.registerListener === 'function') {
    db.registerListener({ statusChanged: check })
  }
}

/**
 * Register global lifecycle listeners that feed the current session's
 * breadcrumb log + clean-shutdown flag, and expose a retrieval hook on
 * `window.__omniliner.forensics` (`dump()` / `download()`) so the recorded
 * breadcrumbs + corruption snapshots can be pulled over the remote inspector
 * or downloaded next incident. A `pagehide` marks a clean exit; a still-unclean
 * flag on the next boot means the process was killed (the process-kill
 * fingerprint). Idempotent; call once at app startup.
 */
export const installDbForensicsLifecycle = (forensics: DbForensics = dbForensics): void => {
  if (lifecycleInstalled || typeof window === 'undefined') return
  lifecycleInstalled = true
  document.addEventListener('visibilitychange', () => {
    void forensics.recordLifecycleEvent(`visibility:${document.visibilityState}`)
  })
  window.addEventListener('freeze', () => void forensics.recordLifecycleEvent('freeze'))
  window.addEventListener('resume', () => void forensics.recordLifecycleEvent('resume'))
  window.addEventListener('pagehide', () => void forensics.markCleanShutdown())

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
  /** Every forensic record (sessions, scan log, unclean archives, snapshots). */
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
