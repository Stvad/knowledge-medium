/*
 * Times a device's initial download. Tracking starts where the database
 * connects, not in the app runtime: on a fresh device the download can finish
 * while the workspace key gate is still up, before anything that would record
 * it has mounted. The result is held until someone takes it.
 */

/** The subset of PowerSync's `SyncStatus` the tracker reads. */
export interface DownloadStatusSample {
  hasSynced?: boolean | null
  downloadProgress?: {
    totalOperations: number
    downloadedOperations: number
    downloadedFraction: number
  } | null
}

export interface DownloadTimings {
  /** Epoch ms when tracking started. */
  startedAtMs: number
  /** Tracking start until progress first reached fraction 1; absent if never observed. */
  downloadMs?: number
  /** From that instant until `hasSynced`; absent if fraction 1 was never observed. */
  applyMs?: number
  /** Tracking start until `hasSynced`. */
  totalMs: number
  /** Max `totalOperations` seen; absent if no progress was ever observed. */
  totalOperations?: number
  /** `downloadedOperations` when progress was first seen. Nonzero means the
   *  download resumed after a reload, so the times are partial. */
  operationsAtStart?: number
}

export interface TrackerClock {
  /** Monotonic ms, for durations. */
  now: () => number
  /** Epoch ms, for stamps only. */
  epoch: () => number
}

const realClock: TrackerClock = { now: () => performance.now(), epoch: () => Date.now() }

export interface DownloadTracker {
  /** Feed a status sample; returns the timings once `hasSynced` is true, else null. */
  sample: (status: DownloadStatusSample) => DownloadTimings | null
}

export const createDownloadTracker = (clock: TrackerClock = realClock): DownloadTracker => {
  const startedAt = clock.now()
  const startedAtMs = clock.epoch()
  let fullAt: number | undefined
  let totalOperations: number | undefined
  let operationsAtStart: number | undefined

  return {
    sample: (status) => {
      const progress = status.downloadProgress
      if (progress) {
        operationsAtStart ??= progress.downloadedOperations
        totalOperations = Math.max(totalOperations ?? 0, progress.totalOperations)
        if (fullAt === undefined && progress.downloadedFraction >= 1) fullAt = clock.now()
      }
      if (!status.hasSynced) return null
      const endedAt = clock.now()
      return {
        startedAtMs,
        downloadMs: fullAt === undefined ? undefined : fullAt - startedAt,
        applyMs: fullAt === undefined ? undefined : endedAt - fullAt,
        totalMs: endedAt - startedAt,
        totalOperations,
        operationsAtStart,
      }
    },
  }
}

/** The slice of a PowerSync database the tracker listens to. */
interface DownloadStatusDb {
  currentStatus?: DownloadStatusSample
  registerListener?: (l: { statusChanged?: (s: DownloadStatusSample) => void }) => () => void
}

const pending = new WeakMap<object, Promise<DownloadTimings>>()

/** Start timing `db`'s initial download, unless it has already synced or is
 *  already tracked. Call once the database is ready: before that `hasSynced`
 *  is not yet known, and every warm boot would read as a download. */
export const trackInitialDownload = (db: DownloadStatusDb, clock: TrackerClock = realClock): void => {
  if (pending.has(db) || db.currentStatus?.hasSynced || typeof db.registerListener !== 'function') return
  const tracker = createDownloadTracker(clock)
  pending.set(db, new Promise<DownloadTimings>((resolve) => {
    let done = false
    const dispose = db.registerListener!({
      statusChanged: (status) => {
        const timings = done ? null : tracker.sample(status)
        if (!timings) return
        done = true
        resolve(timings)
        // Deferred so a listener invoked during registration never reads
        // `dispose` before it is assigned.
        queueMicrotask(() => dispose())
      },
    })
  }))
}

/** The tracked download's timings, resolving when it completes — handed out
 *  ONCE, so a second caller (another workspace's effect, a remount) cannot
 *  record the same download again. Null when none was tracked or it was taken. */
export const takeInitialDownloadTimings = (db: object): Promise<DownloadTimings> | null => {
  const timings = pending.get(db) ?? null
  pending.delete(db)
  return timings
}
