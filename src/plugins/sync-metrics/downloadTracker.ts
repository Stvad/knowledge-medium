/*
 * Pure tracker for the initial download: PowerSync status samples in, stage
 * timings out. Kept free of PowerSync so the logic is testable on its own.
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

export const realClock: TrackerClock = { now: () => performance.now(), epoch: () => Date.now() }

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
