import type { AppEffect } from '@/extensions/core.js'
import type { Repo } from '@/data/repo'
import { scheduleIdle } from '@/utils/scheduleIdle.js'
import { createDownloadTracker, type DownloadStatusSample } from './downloadTracker.ts'
import {
  buildDownloadRecord,
  buildDrainRecord,
  currentHeader,
  isWorthRecording,
  writeSyncMetricsRecord,
  type SyncMetricsRecordData,
} from './record.ts'

/** Never throws into the caller; a refused write is expected (see `writeSyncMetricsRecord`). */
const writeDeferred = (
  repo: Repo,
  workspaceId: string,
  write: typeof writeSyncMetricsRecord,
  data: SyncMetricsRecordData,
): void => {
  scheduleIdle(() => {
    void write(repo, workspaceId, data).catch((err) => {
      console.warn('[sync-metrics] failed to write record', err)
    })
  })
}

/** Structural PowerSync status surface (as `firstSync.ts` does), so no PowerSync import. */
interface StatusDb {
  currentStatus?: DownloadStatusSample
  registerListener: (l: { statusChanged?: (s: DownloadStatusSample) => void }) => () => void
}

export interface SyncMetricsCollectorDeps {
  write?: typeof writeSyncMetricsRecord
}

export const startSyncMetricsCollector = (
  repo: Repo,
  workspaceId: string,
  deps: SyncMetricsCollectorDeps = {},
): (() => void) => {
  const write = deps.write ?? writeSyncMetricsRecord
  const db = repo.db as unknown as StatusDb
  const cleanups: Array<() => void> = []

  cleanups.push(repo.onSyncDrainStats((stats) => {
    if (!isWorthRecording(stats)) return
    const record = buildDrainRecord(
      stats,
      {
        endedAtMs: Date.now(),
        sinceBootMs: performance.now(),
        hasSynced: db.currentStatus?.hasSynced === true,
      },
      currentHeader(),
    )
    writeDeferred(repo, workspaceId, write, record)
  }))

  if (db.currentStatus?.hasSynced !== true) {
    const tracker = createDownloadTracker()
    let finished = false
    const feed = (status: DownloadStatusSample) => {
      if (finished) return
      const timings = tracker.sample(status)
      if (!timings) return
      finished = true
      dispose()
      const record = buildDownloadRecord(timings, currentHeader())
      // The record is a block in the workspace this download just delivered:
      // write it once the drain has materialized that workspace, not into the
      // half-empty one. A failed drain still leaves the record worth keeping.
      void repo.flushSyncObserver().catch(() => {})
        .then(() => writeDeferred(repo, workspaceId, write, record))
    }
    const dispose = db.registerListener({ statusChanged: feed })
    cleanups.push(() => { finished = true; dispose() })
    // The listener only hears changes; take the current sample so progress
    // already in flight is not missed.
    if (db.currentStatus) feed(db.currentStatus)
  }

  return () => { for (const c of cleanups.splice(0)) c() }
}

export const collectSyncMetricsEffect: AppEffect = {
  id: 'sync-metrics.collect',
  start: ({ repo, workspaceId }) => {
    if (!workspaceId) return
    return startSyncMetricsCollector(repo, workspaceId)
  },
}
