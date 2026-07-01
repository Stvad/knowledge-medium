/**
 * The app-wired §16 media byte GC (docs/media-attachments/byte-gc-design.md) — assembles
 * the pure {@link reclaimOrphanedWorkspaces} sweep with the real app deps and runs it for
 * the active user when the session is a SETTLED-SYNCED remote one.
 *
 * v1 reclaims the byte prefixes of workspaces the user no longer has access to (revoke /
 * leave / workspace delete): it gives `byteStore.purgeWorkspace` its first live caller.
 * The membership signal is the local synced `workspaces` table (`SELECT id FROM workspaces`
 * — revoke drops the row); a stored prefix absent from it, past the grace window, is
 * purged. Each purge runs under the SAME per-(user,workspace) down-lane lock the
 * replicator holds, so no in-flight `put` can re-create a just-purged dir (the coordination
 * caveat on `purgeWorkspace`).
 *
 * The gate matters: `isRemoteSyncActive()` rules out a local-only session (where
 * `workspaces` is empty for an unrelated reason), and `hasSynced` rules out a not-yet-
 * settled one (where the local view isn't yet authoritative — a not-yet-downloaded
 * workspace would look absent). The grace window (in {@link reclaimOrphanedWorkspaces})
 * covers the residual imprecision of a global `hasSynced`.
 */

import { getActiveUserId, getPowerSyncDb, isRemoteSyncActive } from '@/data/repoProvider.js'
import { downLaneLockName } from './assetDownLane.js'
import { getByteStore } from './byteStore.js'
import { getGcMarkerStore } from './gcMarkerStore.js'
import { runSingleOwner } from './laneLock.js'
import { reclaimOrphanedWorkspaces } from './mediaGc.js'
import { getByteUploadStore } from './uploadStore.js'

/** Grace window before an orphaned workspace's bytes are purged. Retention-biased (§16
 *  errs toward keeping bytes) and comfortably longer than the transient absences a
 *  checksum-wipe re-download or a momentary membership glitch can produce, so neither ever
 *  triggers a reap — the workspace reappears and the grace clock resets. */
export const GC_GRACE_MS = 24 * 60 * 60 * 1000 // 24 hours

/** Slow periodic sweep cadence. GC is never urgent (a left workspace's bytes are just
 *  wasted space, not a correctness issue), and the marker's cross-session persistence means
 *  the grace clock keeps advancing between sweeps, so this only needs to be frequent enough
 *  to accrue ≥2 observations over the grace window. */
export const GC_SWEEP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

const SELECT_WORKSPACE_IDS_SQL = 'SELECT id FROM workspaces'

/**
 * Run ONE byte-GC sweep for the active user. A no-op when: remote sync is off (local-only —
 * the membership table isn't authoritative), signed out, or initial sync hasn't settled
 * (the local view isn't yet trustworthy). The per-workspace purge is single-owner across
 * tabs via the down-lane lock; a non-owner tab's purge is skipped and retried next sweep.
 */
export const runMediaGcSweep = async (): Promise<void> => {
  if (!isRemoteSyncActive()) return // local-only: `workspaces` is empty for an unrelated reason
  const userId = getActiveUserId()
  if (!userId) return
  const db = getPowerSyncDb(userId)
  if (!db.currentStatus?.hasSynced) return // not settled-synced: local view not yet authoritative

  const byteStore = getByteStore()
  const uploadStore = getByteUploadStore()

  // The set of workspaces still holding un-uploaded (sole-copy) bytes — computed once per
  // sweep and reused across candidates (the sole-copy guard is only consulted for a
  // past-grace orphan, typically none). A staged/pending record's bytes may exist nowhere
  // else, so a workspace holding one is never purged.
  let unUploadedWs: Set<string> | null = null
  const unUploadedWorkspaces = async (): Promise<Set<string>> => {
    if (!unUploadedWs) {
      const [staged, pending] = await Promise.all([
        uploadStore.listByStatus(userId, 'staged'),
        uploadStore.listByStatus(userId, 'pending'),
      ])
      unUploadedWs = new Set([...staged, ...pending].map((r) => r.workspaceId))
    }
    return unUploadedWs
  }

  await reclaimOrphanedWorkspaces({
    userId,
    listStoredWorkspaceIds: () => byteStore.listWorkspaceIds(userId),
    listAccessibleWorkspaceIds: async () => {
      const rows = await db.getAll<{ id: string }>(SELECT_WORKSPACE_IDS_SQL)
      return new Set(rows.map((r) => r.id))
    },
    markers: getGcMarkerStore(),
    hasUnUploadedBytes: async (ws) => (await unUploadedWorkspaces()).has(ws),
    // Purge under the down-lane lock so no in-flight `put` for this workspace races it.
    purgeWorkspace: (ws) =>
      runSingleOwner(downLaneLockName(userId, ws), () => byteStore.purgeWorkspace(userId, ws)),
    now: () => Date.now(),
    graceMs: GC_GRACE_MS,
  })
}
