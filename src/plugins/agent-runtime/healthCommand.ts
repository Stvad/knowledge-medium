import type { Repo } from '@/data/repo'
import type { WorkspaceSyncDivergence } from '@/data/internals/syncObserver/reconcile'
import { MATERIALIZE_QUEUE_COUNT_SQL } from '@/data/internals/syncObserver/observer'
import {
  uploadQueueCountCap,
  uploadQueuePreviewCountSql,
} from '@/plugins/system-status/queueCounts'

/**
 * Layout B sync-health snapshot — the numbers needed to triage a stuck or
 * unsynced client in one read, instead of running each query by hand.
 *
 * The counts reuse the canonical SQL the in-app sync indicator uses
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
  /** Per workspace, downloaded rows `blocks` does not hold with nothing in
   *  flight to deliver them — including STRANDED rows, which no flag or queue
   *  reports. Healthy: []. Remedy: `rematerialize-workspace --scope all` with
   *  that workspace active — unless the entry is `rematerializing` (one is
   *  already running) or `'defer'` (a rescan defers the rows again), and not
   *  for `local-newer` rows, which usually clear once an upload's echo
   *  arrives. */
  syncDivergence: WorkspaceSyncDivergence[]
}

const countOf = async (repo: Repo, sql: string): Promise<number> =>
  (await repo.db.get<{ count: number }>(sql)).count

export const runHealthCommand = async (repo: Repo): Promise<SyncHealthResult> => {
  // The reads are independent — run them concurrently so the command's latency
  // is the slowest single query, not their sum (the divergence probe scans
  // every staged row, and the upload-preview and materialize-backlog scans can
  // be slow on a mid-sync client).
  const [blocks, blocksSynced, uploadQueueBlocks, materializeBacklog, syncDivergence] =
    await Promise.all([
      countOf(repo, 'SELECT count(*) AS count FROM blocks WHERE deleted = 0'),
      countOf(repo, 'SELECT count(*) AS count FROM blocks_synced WHERE deleted = 0'),
      countOf(repo, uploadQueuePreviewCountSql),
      countOf(repo, MATERIALIZE_QUEUE_COUNT_SQL),
      repo.syncDivergence(),
    ])
  return {
    activeWorkspaceId: repo.activeWorkspaceId,
    blocks,
    blocksSynced,
    uploadQueueBlocks,
    uploadQueueApproximate: uploadQueueBlocks > uploadQueueCountCap,
    materializeBacklog,
    syncDivergence,
  }
}
