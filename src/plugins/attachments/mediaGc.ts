/**
 * The pure §16 media byte-GC sweep — reference-counted byte reclamation, run when the
 * byte lanes are quiescent (see `docs/media-attachments/byte-gc-design.md`).
 *
 * This module is the DECISION logic only; {@link import('./assetGc.js')} wires it to the
 * real app deps (byte store, workspaces query, marker store, the down-lane lock) and the
 * settled-synced gate. Keeping it pure + dep-injected is what makes the grace-window and
 * orphan-detection behaviour testable without OPFS / IndexedDB / PowerSync.
 *
 * v1 = BRANCH A, the orphaned-workspace purge: reclaim the whole byte prefix of a
 * workspace the user no longer has access to (revoke / leave / workspace delete). Because
 * a revoked workspace's blocks are physically dropped from the local DB, its reference set
 * is empty and the prefix is wholly reclaimable — no content-key derivation needed (which a
 * revoked E2EE workspace couldn't do anyway; it no longer holds its K_id). This gives
 * `byteStore.purgeWorkspace` its first live caller.
 *
 * Branch B — the per-content-key selective reap WITHIN an accessible workspace (replaced /
 * deleted media, staged orphans) — is designed in the doc and slots in where this sweep
 * clears the marker for an accessible workspace; it is deferred.
 *
 * Two safety rails, both from §16:
 *   - GRACE WINDOW: a workspace must be observed orphaned across ≥2 sweeps AND for at least
 *     `graceMs`, with the clock reset the instant it becomes accessible again. This is
 *     "never a live zero-crossing" — it survives the transient absences a checksum-wipe
 *     re-download or a momentary membership glitch can produce.
 *   - SOLE-COPY GUARD: never purge a workspace that still has un-uploaded (staged/pending)
 *     bytes — those may exist nowhere else. Retention-biased.
 */

import type { GcMarkerStore } from './gcMarkerStore.js'

export interface MediaGcDeps {
  /** The active user whose byte-store prefix this sweep reclaims. */
  readonly userId: string
  /** Workspace ids that currently have bytes stored for this user
   *  (`byteStore.listWorkspaceIds`). Not called when there is nothing to reclaim. */
  readonly listStoredWorkspaceIds: () => Promise<Set<string>>
  /** Workspace ids the user still has access to (`SELECT id FROM workspaces` — revoke /
   *  leave drops the row). The AUTHORITATIVE membership signal; must only be trusted on a
   *  settled-synced session (the caller gates on that). */
  readonly listAccessibleWorkspaceIds: () => Promise<Set<string>>
  /** The grace-window marker store — where "first observed orphaned" persists between
   *  sweeps and across sessions. */
  readonly markers: GcMarkerStore
  /** Does this workspace still hold un-uploaded (staged/pending) bytes? A `true` DEFERS
   *  the purge: those bytes may be the only copy anywhere (never reached remote). */
  readonly hasUnUploadedBytes: (workspaceId: string) => Promise<boolean>
  /** Purge one workspace's whole byte prefix, run single-owner under the per-(user,
   *  workspace) down-lane lock so no in-flight `put` races it. Resolves `true` if it ran,
   *  `false` if another tab owned the lane this tick (retry next sweep). */
  readonly purgeWorkspace: (workspaceId: string) => Promise<boolean>
  /** ms epoch now — injected so tests drive the grace clock. */
  readonly now: () => number
  /** Grace window in ms. A candidate must be continuously orphaned at least this long,
   *  across ≥2 sweeps, before it is purged. */
  readonly graceMs: number
}

export interface MediaGcSummary {
  /** Workspaces whose byte prefix was purged this sweep. */
  readonly purged: readonly string[]
  /** Orphaned candidates left in place this sweep — first sighting, still within grace,
   *  or a lane owned by another tab (retry next sweep). */
  readonly pending: readonly string[]
  /** Past-grace candidates NOT purged because they still hold un-uploaded bytes. */
  readonly skippedUnUploaded: readonly string[]
}

const EMPTY: MediaGcSummary = { purged: [], pending: [], skippedUnUploaded: [] }

/**
 * One orphaned-workspace reclamation sweep. Enumerates the user's stored workspace
 * prefixes, and for each that is no longer accessible, advances the grace state — purging
 * only a candidate that has been continuously orphaned past the window across ≥2 sweeps
 * and holds no un-uploaded bytes. Safe to run repeatedly; idempotent modulo the grace
 * clock. Never throws for an individual workspace's failure — a purge error propagates to
 * the caller's outer catch, but the loop structure keeps one workspace's decision from
 * corrupting another's.
 */
export const reclaimOrphanedWorkspaces = async (deps: MediaGcDeps): Promise<MediaGcSummary> => {
  const stored = await deps.listStoredWorkspaceIds()
  if (stored.size === 0) {
    // Nothing stored for this user — but stale markers may linger (bytes cleared out of
    // band). Prune them so the marker store doesn't accumulate dead rows.
    await pruneStaleMarkers(deps, stored)
    return EMPTY
  }
  const accessible = await deps.listAccessibleWorkspaceIds()
  const now = deps.now()

  const purged: string[] = []
  const pending: string[] = []
  const skippedUnUploaded: string[] = []

  for (const ws of stored) {
    if (accessible.has(ws)) {
      // Still a member → not a candidate. Clear any stale marker so a transient orphaning
      // that just resolved restarts the grace clock on any FUTURE orphaning. (Branch B —
      // the per-content-key reap within an accessible workspace — slots in here.)
      await deps.markers.clear(deps.userId, ws)
      continue
    }

    const marker = await deps.markers.get(deps.userId, ws)
    if (!marker) {
      // First sighting: start the grace clock, never purge on the same sweep. This is what
      // makes a single transient (a mid-wipe empty DB) unable to reclaim anything.
      await deps.markers.set({ userId: deps.userId, workspaceId: ws, firstSeenOrphanedAt: now })
      pending.push(ws)
      continue
    }
    if (now - marker.firstSeenOrphanedAt < deps.graceMs) {
      pending.push(ws) // still within the grace window
      continue
    }
    if (await deps.hasUnUploadedBytes(ws)) {
      skippedUnUploaded.push(ws) // sole-copy guard: those bytes may exist nowhere else
      continue
    }

    const ran = await deps.purgeWorkspace(ws)
    if (ran) {
      await deps.markers.clear(deps.userId, ws)
      purged.push(ws)
    } else {
      pending.push(ws) // another tab owns the lane this tick — retry next sweep
    }
  }

  await pruneStaleMarkers(deps, stored)
  return { purged, pending, skippedUnUploaded }
}

/** Drop markers whose workspace no longer has stored bytes (purged elsewhere, or cleared
 *  out of band by the coarse wipe) so the marker store stays bounded. */
const pruneStaleMarkers = async (deps: MediaGcDeps, stored: ReadonlySet<string>): Promise<void> => {
  for (const m of await deps.markers.listForUser(deps.userId)) {
    if (!stored.has(m.workspaceId)) await deps.markers.clear(deps.userId, m.workspaceId)
  }
}
