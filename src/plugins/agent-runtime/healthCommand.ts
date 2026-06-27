import type { Repo } from '@/data/repo'
import {
  materializeQueueCountSql,
  uploadQueueCountCap,
  uploadQueuePreviewCountSql,
} from '@/plugins/system-status/queueCounts'

/**
 * Layout B sync-health snapshot — the numbers needed to triage a stuck or
 * unsynced client in one read, instead of running the four counts by hand.
 *
 * All counts reuse the canonical SQL the in-app sync indicator uses
 * (queueCounts.ts): in particular the upload queue is DISTINCT blocks, NOT raw
 * `ps_crud` rows (a single edit burst fans out to many rows, so a raw count
 * balloons into a meaningless number).
 */
export interface SyncHealthResult {
  activeWorkspaceId: string | null
  /** App-visible, non-deleted blocks. */
  blocks: number
  /** Rows in the synced staging table. Healthy state: blocks ≈ blocksSynced — a
   *  large shortfall means unmaterialized downloads or local-only data. */
  blocksSynced: number
  /** Distinct blocks queued for upload (capped preview). Healthy: 0. */
  uploadQueueBlocks: number
  /** True when the preview hit its cap, so `uploadQueueBlocks` is a lower bound. */
  uploadQueueApproximate: boolean
  /** `blocks_synced_changes` the observer hasn't applied yet. Healthy: 0. */
  materializeBacklog: number
}

const countOf = async (repo: Repo, sql: string): Promise<number> =>
  (await repo.db.get<{ count: number }>(sql)).count

export const runHealthCommand = async (repo: Repo): Promise<SyncHealthResult> => {
  const blocks = await countOf(repo, 'SELECT count(*) AS count FROM blocks WHERE deleted = 0')
  const blocksSynced = await countOf(repo, 'SELECT count(*) AS count FROM blocks_synced')
  const uploadQueueBlocks = await countOf(repo, uploadQueuePreviewCountSql)
  const materializeBacklog = await countOf(repo, materializeQueueCountSql)
  return {
    activeWorkspaceId: repo.activeWorkspaceId,
    blocks,
    blocksSynced,
    uploadQueueBlocks,
    uploadQueueApproximate: uploadQueueBlocks > uploadQueueCountCap,
    materializeBacklog,
  }
}
