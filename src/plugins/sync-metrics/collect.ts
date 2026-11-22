import type { AppEffect } from '@/extensions/core.js'
import type { Repo } from '@/data/repo'
import { takeInitialDownloadTimings } from '@/data/internals/initialDownload.js'
import { scheduleIdle } from '@/utils/scheduleIdle.js'
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

export interface SyncMetricsCollectorDeps {
  write?: typeof writeSyncMetricsRecord
  takeDownload?: typeof takeInitialDownloadTimings
}

/** Capture lives in core (drain stats replay to a late subscriber, the download
 *  is timed from connect); this only persists what it hands over. */
export const startSyncMetricsCollector = (
  repo: Repo,
  workspaceId: string,
  deps: SyncMetricsCollectorDeps = {},
): (() => void) => {
  const write = deps.write ?? writeSyncMetricsRecord
  const takeDownload = deps.takeDownload ?? takeInitialDownloadTimings
  const cleanups: Array<() => void> = []

  cleanups.push(repo.onSyncDrainStats((stats) => {
    if (!isWorthRecording(stats)) return
    writeDeferred(repo, workspaceId, write, buildDrainRecord(stats, currentHeader()))
  }))

  const download = takeDownload(repo.db)
  if (download) {
    // `workspaceId` may no longer be current once torn down, so nothing is
    // written then; the timings are lost, which is accepted.
    let stopped = false
    cleanups.push(() => { stopped = true })
    void download.then(async (timings) => {
      // The record is a block in the workspace this download just delivered:
      // write it once the drain has materialized that workspace, not into the
      // half-empty one. A failed drain still leaves the record worth keeping.
      await repo.flushSyncObserver().catch(() => {})
      if (stopped) return
      writeDeferred(repo, workspaceId, write, buildDownloadRecord(timings, currentHeader()))
    })
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
