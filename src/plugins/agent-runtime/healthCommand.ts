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
  /** Non-deleted rows in the synced staging table. A ROUGH companion to
   *  `blocks` (both filter `deleted = 0`), not an exact invariant: `blocks` >=
   *  `blocksSynced` is normal (the excess is local-only data not yet uploaded),
   *  and `blocks` materially below `blocksSynced` usually means downloaded rows
   *  the observer hasn't materialized — BUT a locked/undecryptable e2ee
   *  workspace also keeps ciphertext rows in staging that never materialize into
   *  `blocks` (see materializeStagingRows), so a shortfall there is expected.
   *  The precise health numbers are `uploadQueueBlocks` / `materializeBacklog`. */
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
  // The four counts are independent — run them concurrently so the command's
  // latency is the slowest single query, not their sum (the upload-preview and
  // materialize-backlog scans can be the slow ones on a mid-sync client).
  const [blocks, blocksSynced, uploadQueueBlocks, materializeBacklog] = await Promise.all([
    countOf(repo, 'SELECT count(*) AS count FROM blocks WHERE deleted = 0'),
    countOf(repo, 'SELECT count(*) AS count FROM blocks_synced WHERE deleted = 0'),
    countOf(repo, uploadQueuePreviewCountSql),
    countOf(repo, materializeQueueCountSql),
  ])
  return {
    activeWorkspaceId: repo.activeWorkspaceId,
    blocks,
    blocksSynced,
    uploadQueueBlocks,
    uploadQueueApproximate: uploadQueueBlocks > uploadQueueCountCap,
    materializeBacklog,
  }
}
