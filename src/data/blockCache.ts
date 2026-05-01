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

export class BlockCache {
  private readonly snapshots = new Map<string, BlockData>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly pendingLoads = new Map<string, Promise<BlockData | undefined>>()
  /** Per-parent "all children loaded" marker (data-layer §5.2). The
   *  cache cannot distinguish "leaf node" from "children not yet
   *  loaded" by sibling-scanning alone; the marker is the only honest
   *  signal. `repo.load(id, {children: true})` sets it; the row_events
   *  tail clears it when a new child arrives via sync. */
  private readonly allChildrenLoaded = new Set<string>()
  /** Confirmed-missing markers — ids the loader looked up and the row
   *  did not exist (or was soft-deleted). Lets the Block facade
   *  distinguish "not loaded yet" (peek → undefined) from "confirmed
   *  missing" (peek → null) per spec §5.2. Cleared on setSnapshot
   *  (the row exists now). */
  private readonly missingIds = new Set<string>()
  /** Parent-id → child-ids index. Maintained on every snapshot
   *  insert / delete / parent-change so `childrenOf` can answer in
   *  O(children) instead of scanning the full snapshot map. Holds
   *  soft-deleted rows too — `childrenOf` filters those at read time
   *  (the cache keeps tombstones around for undo/devtools per spec
   *  §5.2). */
  private readonly childrenByParent = new Map<string, Set<string>>()

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
    const existing = this.snapshots.get(snapshot.id)

    if (existing && blockFingerprint(existing) === blockFingerprint(snapshot)) {
      return false
    }

    // Maintain parent-children index. If the snapshot is new or its
    // parentId moved, update the index before storing the new snapshot.
    if (!existing) {
      this.addToParentIndex(snapshot.parentId, snapshot.id)
    } else if (existing.parentId !== snapshot.parentId) {
      this.removeFromParentIndex(existing.parentId, snapshot.id)
      this.addToParentIndex(snapshot.parentId, snapshot.id)
    }

    this.snapshots.set(snapshot.id, deepFreeze(snapshot))
    // Row is now known-present — clear any prior confirmed-missing state.
    this.missingIds.delete(snapshot.id)
    this.notify(snapshot.id)
    return true
  }

  /** LWW-gated snapshot write for sync-arrival paths (row_events tail,
   *  re-reads from SQL inside `repo.load`). Rejects an incoming
   *  snapshot whose `updatedAt` is older than what's already cached —
   *  PowerSync can deliver an older row state during the upload window
   *  while the local commit pipeline has already advanced the cache,
   *  and re-reading the SQLite row after a sync-clobber would
   *  otherwise reintroduce the stale state. Equal `updatedAt` accepts
   *  (covers the common echo-of-our-own-write case, which is a no-op
   *  via fingerprint dedup inside `setSnapshot`). */
  applySyncSnapshot(snapshot: BlockData): boolean {
    const existing = this.snapshots.get(snapshot.id)
    if (existing && snapshot.updatedAt < existing.updatedAt) return false
    return this.setSnapshot(snapshot)
  }

  deleteSnapshot(id: string): boolean {
    const existing = this.snapshots.get(id)
    if (!this.snapshots.delete(id)) return false
    if (existing) this.removeFromParentIndex(existing.parentId, id)

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
    this.listeners.get(id)?.forEach(listener => listener())
  }

  // ──── allChildrenLoaded markers ────

  /** Mark that the cache holds the complete set of children for a
   *  parent. Set by `repo.load(parentId, {children: true})` and by the
   *  subtree loader. */
  markChildrenLoaded(parentId: string): void {
    this.allChildrenLoaded.add(parentId)
  }

  /** Clear the marker — call when a new child has appeared (e.g.
   *  sync-applied insert with this parent_id). */
  clearChildrenLoaded(parentId: string): void {
    this.allChildrenLoaded.delete(parentId)
  }

  /** True iff the cache marker says all children of `parentId` are
   *  loaded. Used by `Block.childIds` / `Block.children` to decide
   *  whether the sync getter is honest or should throw
   *  `ChildrenNotLoadedError`. */
  areChildrenLoaded(parentId: string): boolean {
    return this.allChildrenLoaded.has(parentId)
  }

  // ──── Confirmed-missing markers ────

  /** Mark `id` as confirmed-missing — `repo.load` looked it up and the
   *  row didn't exist (or was soft-deleted). Block.peek will return
   *  null instead of undefined; Block.data will throw
   *  BlockNotFoundError instead of BlockNotLoadedError.
   *  Notifies subscribers on the first transition into missing — a
   *  subscribed Block facade re-renders when its row is confirmed
   *  gone. Repeat calls (already missing) are no-ops to avoid
   *  spurious re-renders. */
  markMissing(id: string): boolean {
    if (this.missingIds.has(id)) return false
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

  /** Children of `parentId` from the cache, ordered by `(orderKey, id)`,
   *  filtered to non-deleted rows. The caller is responsible for
   *  having checked `areChildrenLoaded(parentId)` first; this helper
   *  doesn't verify the marker because (a) `block.childIds` does it
   *  in the throw path, and (b) sometimes — e.g. inside a tx —
   *  callers want a best-effort sibling list and accept the
   *  partial-cache risk.
   *
   *  Reads from `childrenByParent` so the cost is O(children) instead
   *  of a full O(snapshots) scan — important for tree-walks like
   *  `getAllVisibleBlockIdsInOrder` which call this once per visited
   *  block. */
  childrenOf(parentId: string): BlockData[] {
    const childIds = this.childrenByParent.get(parentId)
    if (!childIds || childIds.size === 0) return []
    const out: BlockData[] = []
    for (const id of childIds) {
      const data = this.snapshots.get(id)
      if (data && !data.deleted) out.push(data)
    }
    out.sort((a, b) => {
      if (a.orderKey < b.orderKey) return -1
      if (a.orderKey > b.orderKey) return 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    return out
  }

  // ──── Parent-children index maintenance ────

  private addToParentIndex(parentId: string | null, childId: string): void {
    if (parentId === null) return
    let set = this.childrenByParent.get(parentId)
    if (!set) {
      set = new Set()
      this.childrenByParent.set(parentId, set)
    }
    set.add(childId)
  }

  private removeFromParentIndex(parentId: string | null, childId: string): void {
    if (parentId === null) return
    const set = this.childrenByParent.get(parentId)
    if (!set) return
    set.delete(childId)
    if (set.size === 0) this.childrenByParent.delete(parentId)
  }
}
