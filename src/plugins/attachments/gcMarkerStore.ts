/**
 * Durable grace-window markers for the §16 media byte GC (see
 * `docs/media-attachments/byte-gc-design.md`).
 *
 * The GC never reclaims on a live zero-crossing: a workspace that has stored bytes
 * but is no longer in the user's accessible set (revoked / left / deleted) is only
 * an ORPHAN CANDIDATE, and must stay one continuously for a grace window — observed
 * across ≥2 sweeps — before its bytes are purged. This store is where "first observed
 * orphaned at" persists between sweeps AND across sessions (the grace clock keeps
 * accruing while the app is closed), so the sweep is stateless.
 *
 * The clock RESETS the moment a workspace stops being a candidate: when it becomes
 * accessible again (a transient membership/sync glitch, or the checksum-wipe transient
 * that momentarily empties the local DB), or once its bytes are purged, the sweep
 * clears the marker. That reset is what makes the grace window safe against transients.
 *
 * Keyed by `(user_id, workspace_id)` — `user_id` is load-bearing: the OPFS byte store
 * this guards is shared across the browser profile's accounts, so every marker is
 * namespaced by the user, exactly like {@link import('./uploadStore.js').ByteUploadStore}.
 *
 * Production backing is IndexedDB (via the shared {@link IdbKeyedStore}); tests and the
 * no-IndexedDB fallback use {@link InMemoryGcMarkerStore}. Records are plain JSON.
 */

import { IdbKeyedStore, idbKeyPrefix, idbRecordId } from '@/utils/idbKeyedStore.js'

export interface GcMarker {
  readonly userId: string
  readonly workspaceId: string
  /** ms epoch when this workspace was FIRST observed orphaned (holds stored bytes but
   *  is absent from the user's accessible workspaces). The grace window is measured
   *  from here; the sweep clears the marker if the workspace becomes accessible again,
   *  restarting the clock on any future orphaning. */
  readonly firstSeenOrphanedAt: number
}

export interface GcMarkerStore {
  /** The orphan marker for one (user, workspace), or `null` if this workspace is not
   *  currently a tracked candidate. */
  get(userId: string, workspaceId: string): Promise<GcMarker | null>
  /** Record / overwrite an orphan marker (the sweep sets it on first sighting). */
  set(marker: GcMarker): Promise<void>
  /** Drop one marker — the sweep calls this when a workspace becomes accessible again
   *  or once its bytes are purged. Idempotent. */
  clear(userId: string, workspaceId: string): Promise<void>
  /** Every marker for this user — the sweep reads it to prune markers whose workspace
   *  no longer has stored bytes (e.g. cleared out-of-band by the coarse wipe). Scoped
   *  to `userId`. */
  listForUser(userId: string): Promise<GcMarker[]>
  /** Drop every marker FOR THIS USER (account isolation — the store is shared across
   *  the profile's accounts). */
  clearForUser(userId: string): Promise<void>
}

/** In-memory store. Tests + the fallback when IndexedDB is unavailable (the grace clock
 *  then only accrues within the page's lifetime — a reload restarts a candidate's grace,
 *  which is retention-biased and therefore safe). */
export class InMemoryGcMarkerStore implements GcMarkerStore {
  private readonly markers = new Map<string, GcMarker>()

  async get(userId: string, workspaceId: string): Promise<GcMarker | null> {
    return this.markers.get(idbRecordId(userId, workspaceId)) ?? null
  }

  async set(marker: GcMarker): Promise<void> {
    this.markers.set(idbRecordId(marker.userId, marker.workspaceId), marker)
  }

  async clear(userId: string, workspaceId: string): Promise<void> {
    this.markers.delete(idbRecordId(userId, workspaceId))
  }

  async listForUser(userId: string): Promise<GcMarker[]> {
    const prefix = idbKeyPrefix(userId)
    return [...this.markers.entries()]
      .filter(([id]) => id.startsWith(prefix))
      .map(([, m]) => m)
  }

  async clearForUser(userId: string): Promise<void> {
    const prefix = idbKeyPrefix(userId)
    for (const id of [...this.markers.keys()]) {
      if (id.startsWith(prefix)) this.markers.delete(id)
    }
  }
}

export const GC_MARKER_STORE_DB_NAME = 'km-media-gc'
const STORE_NAME = 'orphan-markers'

/** IndexedDB-backed store — the grace clock survives reloads and sessions (a candidate
 *  orphaned yesterday is still past-grace today), via the shared {@link IdbKeyedStore}. */
export class IndexedDbGcMarkerStore implements GcMarkerStore {
  private readonly idb = new IdbKeyedStore(GC_MARKER_STORE_DB_NAME, STORE_NAME)

  async get(userId: string, workspaceId: string): Promise<GcMarker | null> {
    const result = await this.idb.tx<GcMarker | undefined>('readonly', store =>
      store.get(idbRecordId(userId, workspaceId)),
    )
    return result ?? null
  }

  async set(marker: GcMarker): Promise<void> {
    await this.idb.tx('readwrite', store =>
      store.put(marker, idbRecordId(marker.userId, marker.workspaceId)),
    )
  }

  async clear(userId: string, workspaceId: string): Promise<void> {
    await this.idb.tx('readwrite', store => store.delete(idbRecordId(userId, workspaceId)))
  }

  async listForUser(userId: string): Promise<GcMarker[]> {
    const out: GcMarker[] = []
    await this.idb.scanByPrefix('readonly', idbKeyPrefix(userId), cursor => {
      out.push(cursor.value as GcMarker)
    })
    return out
  }

  async clearForUser(userId: string): Promise<void> {
    await this.idb.deleteByPrefix(idbKeyPrefix(userId))
  }
}

/** Pick the production store when IndexedDB exists, else the in-memory fallback. */
export const createGcMarkerStore = (): GcMarkerStore => {
  try {
    if (typeof indexedDB !== 'undefined') return new IndexedDbGcMarkerStore()
  } catch {
    // fall through
  }
  return new InMemoryGcMarkerStore()
}

// Process-wide singleton — the sweep must share ONE store within a session (an
// IndexedDB instance is shared storage, but a single instance also keeps the
// in-memory fallback coherent). Tests inject their own store and never touch this.
let sharedStore: GcMarkerStore | null = null
export const getGcMarkerStore = (): GcMarkerStore => (sharedStore ??= createGcMarkerStore())
