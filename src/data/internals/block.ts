/**
 * New `Block` sync facade (spec §5.2). Loading is an explicit boundary
 * (`block.load()` or `repo.load(id, opts)`); post-load access is sync.
 *
 * The legacy `Block` class at `src/data/block.ts` stays in place until
 * stage 1.6 sweeps the call sites; the new shape lives here under
 * `src/data/internals/block.ts` so the migration is mechanical.
 *
 * What this NOT-yet-includes (deferred to stage 2 of Phase 1):
 *   - HandleStore-backed reactive `subscribe` returning a Handle —
 *     `subscribe(listener)` here goes directly through `BlockCache.subscribe`,
 *     which gives the right behavior for the call-site sweep that uses
 *     `useSyncExternalStore` against the cache anyway.
 *   - `useHandle(handle)` adapter — comes when handles arrive.
 */

import {
  BlockNotFoundError,
  BlockNotLoadedError,
  ChildrenNotLoadedError,
  type BlockData,
  type PropertySchema,
  type Unsubscribe,
} from '@/data/api'
import type { Repo } from './repo'

export class Block {
  readonly id: string
  readonly repo: Repo

  constructor(repo: Repo, id: string) {
    this.repo = repo
    this.id = id
  }

  // ──── Reads ────

  /** Sync read; throws BlockNotLoadedError if the row isn't loaded,
   *  BlockNotFoundError if `repo.load` previously confirmed the row
   *  doesn't exist (§5.2). A soft-deleted row counts as loaded — the
   *  facade exposes it with `deleted: true` so undo flows / devtools
   *  can inspect it; consumers that want only-live filter themselves. */
  get data(): BlockData {
    const snap = this.repo.cache.getSnapshot(this.id)
    if (snap !== undefined) return snap
    if (this.repo.cache.isMissing(this.id)) throw new BlockNotFoundError(this.id)
    throw new BlockNotLoadedError(this.id)
  }

  /** Soft access (§5.2):
   *    undefined → not loaded yet
   *    null      → confirmed missing (load returned null)
   *    BlockData → loaded (possibly soft-deleted) */
  peek(): BlockData | undefined | null {
    const snap = this.repo.cache.getSnapshot(this.id)
    if (snap !== undefined) return snap
    if (this.repo.cache.isMissing(this.id)) return null
    return undefined
  }

  /** Ensure loaded. Idempotent + dedup'd via the cache's pendingLoads
   *  table. Returns null when the row doesn't exist. */
  load(): Promise<BlockData | null> {
    return this.repo.load(this.id)
  }

  /** Subscribe to cache mutations for this id. */
  subscribe(listener: (data: BlockData | null) => void): Unsubscribe {
    return this.repo.cache.subscribe(this.id, () => {
      const next = this.repo.cache.getSnapshot(this.id) ?? null
      listener(next)
    })
  }

  // ──── Properties ────

  /** Sync property read with codec.decode + schema defaultValue
   *  fallback. Throws BlockNotLoadedError if the row isn't loaded. */
  get<T>(schema: PropertySchema<T>): T {
    const data = this.data  // throws if not loaded
    const stored = data.properties[schema.name]
    if (stored === undefined) return schema.defaultValue
    return schema.codec.decode(stored)
  }

  /** Like `get` but doesn't substitute the default — returns undefined
   *  when the property is absent. */
  peekProperty<T>(schema: PropertySchema<T>): T | undefined {
    const snap = this.peek()
    if (snap === undefined || snap === null) return undefined
    const stored = snap.properties[schema.name]
    if (stored === undefined) return undefined
    return schema.codec.decode(stored)
  }

  // ──── Tree relatives (sync; require neighborhood pre-loaded) ────

  /** Children ids in (orderKey, id) order. Throws
   *  `ChildrenNotLoadedError` if the cache doesn't know whether all
   *  children are loaded. */
  get childIds(): string[] {
    if (!this.repo.cache.areChildrenLoaded(this.id)) {
      throw new ChildrenNotLoadedError(this.id)
    }
    return this.repo.cache.childrenOf(this.id).map(c => c.id)
  }

  /** Children as Block instances. Same gating as `childIds`. */
  get children(): Block[] {
    return this.childIds.map(id => new Block(this.repo, id))
  }

  /** Parent as Block, or null if no parent (workspace root) or if the
   *  parent row isn't in cache. (Throwing here would be too strict —
   *  most callers want best-effort.) */
  get parent(): Block | null {
    const data = this.peek()
    if (data === undefined || data === null) return null
    if (data.parentId === null) return null
    if (!this.repo.cache.getSnapshot(data.parentId)) return null
    return new Block(this.repo, data.parentId)
  }

  // ──── Single-block write sugar (each is a 1-mutator tx) ────

  /** Set a typed property. Each call is its own tx, equivalent to
   *  `repo.mutate.setProperty({id, schema, value})`. */
  async set<T>(schema: PropertySchema<T>, value: T): Promise<void> {
    await this.repo.mutate.setProperty({id: this.id, schema, value})
  }

  /** Set the block's content. */
  async setContent(content: string): Promise<void> {
    await this.repo.mutate.setContent({id: this.id, content})
  }

  /** Subtree-aware soft-delete (mirrors legacy `Block.delete`). */
  async delete(): Promise<void> {
    await this.repo.mutate.delete({id: this.id})
  }
}

/** Internal helper: throw a typed error for "block confirmed missing
 *  by repo.load". Called by load paths to convert null returns into a
 *  thrown error when the caller wants strict behavior. */
export const requireLoadedBlock = (block: Block): BlockData => {
  const data = block.peek()
  if (data === undefined) throw new BlockNotLoadedError(block.id)
  if (data === null) throw new BlockNotFoundError(block.id)
  return data
}
