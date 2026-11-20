/**
 * Sync-metrics persistence: real-device numbers for large sync materialization
 * drains and for the initial download, stored as block-per-sample under a
 * hidden per-user ui-state subtree (same storage as startup-metrics, via
 * `appendClientRecord`). Records carry no workspace ids, block ids, names or
 * content.
 */

import { ChangeScope, seedProperty, seedType } from '@/data/api'
import type { Repo } from '@/data/repo'
import type { SyncDrainStats } from '@/data/internals/syncObserver/observer'
import { appVersion } from '@/appVersion.js'
import { getClientId, getDeviceLabel } from '@/utils/clientId.js'
import { awaitRecordingAllowed, NoLongerEligible } from '@/plugins/interaction-metrics/sessionContext.js'
import { appendClientRecord } from '@/plugins/interaction-metrics/recordStore.js'
import type { DownloadTimings } from './downloadTracker.ts'

/** Identity of the device and build a sample came from. */
export interface SyncRecordHeader {
  /** Wall-clock epoch ms at which the sample was taken. */
  recordedAt: number
  appVersion: string
  appSha: string
  clientId: string
  deviceLabel: string
}

export type SyncDrainRecordData = SyncRecordHeader & {
  kind: 'drain'
  /** Epoch ms when the stats arrived. */
  endedAtMs: number
  /** `performance.now()` when the stats arrived: how far into the page's life. */
  sinceBootMs: number
  /** Whether the initial download had completed when the stats arrived. */
  hasSynced: boolean
} & SyncDrainStats

export type SyncDownloadRecordData = SyncRecordHeader & {
  kind: 'download'
} & DownloadTimings

export type SyncMetricsRecordData = SyncDrainRecordData | SyncDownloadRecordData

/** The whole sample rides one identity-codec property, so the shape can evolve
 *  without per-field schema churn. */
export const syncMetricsRecordProp = seedProperty<SyncMetricsRecordData | undefined>({
  seedKey: 'system:sync-metrics/property/sync-metrics-record',
  revision: 1,
  name: 'syncMetricsRecord',
  preset: 'optional-json',
  defaultValue: undefined,
  // Automation scope (not UiState) so the record is visible in the property panel.
  changeScope: ChangeScope.Automation,
})

export const syncMetricsRecordType = seedType({
  seedKey: 'system:sync-metrics/type/sync-metrics-record',
  revision: 1,
  id: 'sync-metrics-record',
  label: 'Sync metrics record',
  hideFromCompletion: true,
  properties: [syncMetricsRecordProp],
})

/** Parent ui-state container; each sample adds one child under this client's group. */
export const syncMetricsUIStateType = seedType({
  seedKey: 'system:sync-metrics/type/sync-metrics',
  revision: 1,
  id: 'sync-metrics',
  label: 'Sync metrics',
  hideFromCompletion: true,
  properties: [],
})

/** Samples kept per client; drain samples are thresholded, so this is a long horizon. */
export const SYNC_METRICS_RETAIN = 500

/** The drain listener fires per arrival in steady state; only a backlog-sized
 *  drain (rows) or a slow one (wallMs) is worth a block. */
export const DRAIN_RECORD_MIN_ROWS = 1000
export const DRAIN_RECORD_MIN_WALL_MS = 5000

export const isWorthRecording = (stats: Pick<SyncDrainStats, 'rows' | 'wallMs'>): boolean =>
  stats.rows >= DRAIN_RECORD_MIN_ROWS || stats.wallMs >= DRAIN_RECORD_MIN_WALL_MS

export const currentHeader = (): SyncRecordHeader => ({
  recordedAt: Date.now(),
  appVersion: appVersion.display,
  appSha: appVersion.sha,
  clientId: getClientId(),
  deviceLabel: getDeviceLabel(),
})

/** Pure: stats + arrival context -> storable record, ms rounded to integers. */
export const buildDrainRecord = (
  stats: SyncDrainStats,
  arrival: { endedAtMs: number; sinceBootMs: number; hasSynced: boolean },
  header: SyncRecordHeader,
): SyncDrainRecordData => ({
  ...header,
  kind: 'drain',
  endedAtMs: Math.round(arrival.endedAtMs),
  sinceBootMs: Math.round(arrival.sinceBootMs),
  hasSynced: arrival.hasSynced,
  ...stats,
  wallMs: Math.round(stats.wallMs),
  readMs: Math.round(stats.readMs),
  decodeMs: Math.round(stats.decodeMs),
  writeMs: Math.round(stats.writeMs),
  invalidateMs: Math.round(stats.invalidateMs),
  bookkeepingMs: Math.round(stats.bookkeepingMs),
})

/** Pure: tracker output -> storable record. Unobserved phases stay absent. */
export const buildDownloadRecord = (
  timings: DownloadTimings,
  header: SyncRecordHeader,
): SyncDownloadRecordData => ({
  ...header,
  kind: 'download',
  startedAtMs: Math.round(timings.startedAtMs),
  downloadMs: roundOptional(timings.downloadMs),
  applyMs: roundOptional(timings.applyMs),
  totalMs: Math.round(timings.totalMs),
  totalOperations: timings.totalOperations,
  operationsAtStart: timings.operationsAtStart,
})

function roundOptional(ms: number | undefined): number | undefined {
  return ms === undefined ? undefined : Math.round(ms)
}

/** Append one sample under this client's group. Null when recording isn't
 *  allowed (read-only, unresolved role, workspace switched). */
export const writeSyncMetricsRecord = async (
  repo: Repo,
  workspaceId: string,
  data: SyncMetricsRecordData,
): Promise<string | null> => {
  if (!(await awaitRecordingAllowed(repo, workspaceId))) return null
  try {
    return (await appendClientRecord(repo, {
      workspaceId,
      containerType: syncMetricsUIStateType,
      recordType: syncMetricsRecordType,
      description: `sync metrics ${data.kind} record`,
      retain: SYNC_METRICS_RETAIN,
      orderField: 'recordedAt',
      recordName: syncMetricsRecordProp.name,
      record: { property: syncMetricsRecordProp, data },
    })).blockId
  } catch (err) {
    if (err instanceof NoLongerEligible) return null
    throw err
  }
}
