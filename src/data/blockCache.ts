import type { BlockData } from '@/types'

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

const blockFingerprint = (blockData: BlockData | undefined) =>
  blockData ? JSON.stringify(blockData) : ''

/** Counter object for BlockCache write/notify activity (perf-baseline
 *  follow-up #4). One instance per BlockCache; increments inline in
 *  the hot path. Snapshot via `snapshot()` for a frozen plain-object
 *  view consumers can diff between samples. */
export class BlockCacheMetrics {
  /** Total `setSnapshot(...)` calls (every entry, every path). Includes
   *  calls reached through `applySyncSnapshot`. */
  setSnapshotCalls = 0
  /** `setSnapshot` calls where the incoming fingerprint matched the
   *  cached one — dedup hit, no listeners walked. */
  setSnapshotDedupHits = 0
  /** `setSnapshot` calls that actually wrote and notified. */
  setSnapshotDedupMisses = 0
  /** Total `applySyncSnapshot(...)` calls (sync-arrival LWW path). */
  applySyncSnapshotCalls = 0
  /** `applySyncSnapshot` calls rejected because the incoming
   *  `updatedAt` was older than what's already cached. */
  applySyncSnapshotRejected = 0
  /** Total internal `notify(id)` invocations across all paths
   *  (setSnapshot writes, deleteSnapshot, markMissing, clearMissing).
   *  Counts the call, not the per-listener fan-out. */
  notifies = 0

  reset(): void {
    this.setSnapshotCalls = 0
    this.setSnapshotDedupHits = 0
    this.setSnapshotDedupMisses = 0
    this.applySyncSnapshotCalls = 0
    this.applySyncSnapshotRejected = 0
    this.notifies = 0
  }

  /** Frozen plain-object snapshot — safe to keep as a baseline for
   *  diffing between samples. */
  snapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      setSnapshotCalls: this.setSnapshotCalls,
      setSnapshotDedupHits: this.setSnapshotDedupHits,
      setSnapshotDedupMisses: this.setSnapshotDedupMisses,
      applySyncSnapshotCalls: this.applySyncSnapshotCalls,
      applySyncSnapshotRejected: this.applySyncSnapshotRejected,
      notifies: this.notifies,
    })
  }
}

/** In-memory mirror of the per-row state of `blocks`. Holds:
 *
 *    - per-id BlockData snapshots (with subscriber list)
 *    - confirmed-missing markers (for the Block facade's loaded/missing
 *      distinction per spec §5.2)
 *
 *  Collection state (children, subtree, ancestors, backlinks) is NOT
 *  cached here — it lives on `LoaderHandle`s registered with the
 *  `HandleStore`, which is the single home for collection caching +
 *  invalidation. Imperative callers that want children read from the
 *  `repo.children(id)` / `repo.childIds(id)` handles, not from this
 *  class. */
export class BlockCache {
  private readonly snapshots = new Map<string, BlockData>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly pendingLoads = new Map<string, Promise<BlockData | undefined>>()
  /** Confirmed-missing markers — ids the loader looked up and the row
   *  did not exist (or was soft-deleted). Lets the Block facade
   *  distinguish "not loaded yet" (peek → undefined) from "confirmed
   *  missing" (peek → null) per spec §5.2. Cleared on setSnapshot
   *  (the row exists now). */
  private readonly missingIds = new Set<string>()
  /** Mutable counters for cache write/notify activity. Increments
   *  inline in the hot path; consumers snapshot via `metrics.snapshot()`
   *  through `repo.metrics()`. */
  readonly metrics = new BlockCacheMetrics()

  getSnapshot(id: string): BlockData | undefined {
    return this.snapshots.get(id)
  }

  hasSnapshot(id: string): boolean {
    return this.snapshots.has(id)
  }

  requireSnapshot(id: string): BlockData {
    const snapshot = this.snapshots.get(id)
    if (!snapshot) {
      throw new Error(`Block is not loaded yet: ${id}`)
    }
    return snapshot
  }

  /** Unconditional snapshot write. Used by the local commit pipeline,
   *  whose write IS the latest authoritative state for the row. Returns
   *  true if listeners were notified (i.e. the snapshot actually
   *  changed by fingerprint). */
  setSnapshot(snapshot: BlockData): boolean {
    this.metrics.setSnapshotCalls++
    const existing = this.snapshots.get(snapshot.id)

    if (existing && blockFingerprint(existing) === blockFingerprint(snapshot)) {
      this.metrics.setSnapshotDedupHits++
      return false
    }

    this.metrics.setSnapshotDedupMisses++
    const dbg = (globalThis as unknown as {__cacheDebug?: {ids: Set<string>; log: unknown[]}}).__cacheDebug
    if (dbg && dbg.ids.has(snapshot.id)) {
      dbg.log.push({
        t: typeof performance !== 'undefined' ? performance.now().toFixed(1) : '0',
        kind: 'setSnapshot',
        id: snapshot.id,
        prevContent: existing?.content,
        prevUA: existing?.updatedAt,
        newContent: snapshot.content.length > 60 ? snapshot.content.slice(0, 60) + '…' : snapshot.content,
        newUA: snapshot.updatedAt,
      })
    }
    this.snapshots.set(snapshot.id, deepFreeze(snapshot))
    // Row is now known-present — clear any prior confirmed-missing state.
    this.missingIds.delete(snapshot.id)
    this.notify(snapshot.id)
    return true
  }

  /** LWW-gated snapshot write for sync-arrival paths (row_events tail,
   *  re-reads from SQL inside `repo.load`, query hydrate-rows). Rejects
   *  an incoming snapshot whose `updatedAt` is NOT STRICTLY NEWER than
   *  what's already cached — PowerSync can deliver an older row state
   *  during the upload window while the local commit pipeline has
   *  already advanced the cache, and re-reading the SQLite row after a
   *  sync-clobber would otherwise reintroduce the stale state.
   *
   *  Why `<=` not `<`: under rapid local typing, two writes can share
   *  `Date.now()` ms (and processor writes with `skipMetadata: true`
   *  preserve the prior `updatedAt`, multiplying the collision
   *  surface). An in-flight query that reads SQL between two such
   *  same-ms writes can fire `applySyncSnapshot` LATER with the
   *  earlier-but-equal-ms content — `<` would accept it and clobber
   *  the cache with stale content. `<=` rejects equal-ms snapshots;
   *  same-`updatedAt`-same-content rounds to a no-op anyway via
   *  fingerprint dedup, so this only blocks the harmful clobber. */
  applySyncSnapshot(snapshot: BlockData): boolean {
    this.metrics.applySyncSnapshotCalls++
    const existing = this.snapshots.get(snapshot.id)
    if (existing && snapshot.updatedAt <= existing.updatedAt) {
      this.metrics.applySyncSnapshotRejected++
      const dbg = (globalThis as unknown as {__cacheDebug?: {ids: Set<string>; log: unknown[]}}).__cacheDebug
      if (dbg && dbg.ids.has(snapshot.id)) {
        dbg.log.push({
          t: typeof performance !== 'undefined' ? performance.now().toFixed(1) : '0',
          kind: 'applySyncSnapshot-REJECT',
          id: snapshot.id,
          existingContent: existing.content,
          existingUA: existing.updatedAt,
          incomingContent: snapshot.content.length > 60 ? snapshot.content.slice(0, 60) + '…' : snapshot.content,
          incomingUA: snapshot.updatedAt,
        })
      }
      return false
    }
    return this.setSnapshot(snapshot)
  }

  deleteSnapshot(id: string): boolean {
    if (!this.snapshots.delete(id)) return false

    this.notify(id)
    return true
  }

  subscribe(id: string, listener: () => void): () => void {
    let listeners = this.listeners.get(id)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(id, listeners)
    }
    listeners.add(listener)

    return () => {
      listeners?.delete(listener)
      if (listeners?.size === 0) {
        this.listeners.delete(id)
      }
    }
  }

  trackedIds(): Set<string> {
    return new Set(this.listeners.keys())
  }

  dedupLoad(
    id: string,
    loader: () => Promise<BlockData | undefined>,
  ): Promise<BlockData | undefined> {
    const existing = this.pendingLoads.get(id)
    if (existing) return existing

    const promise = loader().finally(() => {
      this.pendingLoads.delete(id)
    })
    this.pendingLoads.set(id, promise)
    return promise
  }

  private notify(id: string): void {
    this.metrics.notifies++
    this.listeners.get(id)?.forEach(listener => listener())
  }

  // ──── Confirmed-missing markers ────

  /** Mark `id` as confirmed-missing — `repo.load` looked it up and the
   *  row didn't exist (or was soft-deleted). Block.peek will return
   *  null instead of undefined; Block.data will throw
   *  BlockNotFoundError instead of BlockNotLoadedError.
   *  Notifies subscribers on the first transition into missing — a
   *  subscribed Block facade re-renders when its row is confirmed
   *  gone. Repeat calls (already missing) are no-ops to avoid
   *  spurious re-renders.
   *
   *  Also drops any cached snapshot for this id. Block.peek/data,
   *  status(), and repo.exists all consult the snapshot map first; if
   *  a stale snapshot remained behind a freshly-set missing marker,
   *  the facade would keep returning the old row state and never
   *  observe the deletion. Notifies once even when both sides changed
   *  — subscribers don't care which transition fired, only that they
   *  should re-read. */
  markMissing(id: string): boolean {
    const hadMarker = this.missingIds.has(id)
    const hadSnapshot = this.snapshots.delete(id)
    if (hadMarker && !hadSnapshot) return false
    this.missingIds.add(id)
    this.notify(id)
    return true
  }

  /** True iff `id` was previously confirmed-missing AND no snapshot
   *  has since arrived. */
  isMissing(id: string): boolean {
    return this.missingIds.has(id)
  }

  /** Clear the confirmed-missing marker — used by tests or by the
   *  row_events tail when a sync-applied insert means we should re-check.
   *  Notifies subscribers if the marker was actually cleared so the
   *  facade exits the "confirmed-missing" branch on its next read.
   *  (setSnapshot also clears the marker, but it always notifies
   *  on its own as part of the snapshot-update path.) */
  clearMissing(id: string): boolean {
    if (!this.missingIds.delete(id)) return false
    this.notify(id)
    return true
  }
}
