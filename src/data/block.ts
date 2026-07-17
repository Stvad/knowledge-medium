/**
 * `Block` — sync facade + Handle<BlockData|null> for a single block row
 * (spec §5.1, §5.2).
 *
 * Block satisfies the Handle interface structurally (peek/load/subscribe/
 * read/status/key) AND adds the OO sugar that 95% of imperative call
 * sites use: `data` (sync, throws), `childIds` / `children` / `parent`
 * (sync tree relatives), `get` / `peekProperty` (typed property reads),
 * `set` / `setContent` / `delete` (single-block write sugar). Picking one
 * object that does both jobs (vs. a separate `Handle` and `Block`) keeps
 * the call-site surface uniform and unifies "row reactivity" with "row
 * imperative work" under one identity-stable instance — see the
 * data-layer-redesign task §13.2 design discussion.
 *
 * Identity: the same `Block` instance is returned from `repo.block(id)`
 * for a given id (Repo holds them in `blockFacades`). Block does NOT
 * register with `HandleStore` — its row-grain subscriptions go through
 * `BlockCache.subscribe(id, …)` (already in place from Phase 1) and the
 * cache fires whenever the snapshot changes. HandleStore is the registry
 * for *collection* handles (`repo.children/subtree/ancestors/backlinks`),
 * which need the dependency-shaped invalidation index that the row-grain
 * cache already provides for free.
 */

import {
  BlockNotFoundError,
  BlockNotLoadedError,
  type BlockData,
  type Handle,
  type HandleStatus,
  type PropertySchema,
  type Unsubscribe,
} from '@/data/api'
import type { Repo } from './repo'
import type { LoaderHandle } from './internals/handleStore'
import { getBlockTypes } from './properties'

const liveSnapshot = (snapshot: BlockData | undefined): BlockData | undefined | null => {
  if (snapshot === undefined) return undefined
  return snapshot.deleted ? null : snapshot
}

export class Block implements Handle<BlockData | null> {
  readonly id: string
  readonly repo: Repo

  /** Inflight `load()` promise — dedup'd at the Block level so Suspense
   *  paths can throw a stable promise across renders. Cleared once it
   *  settles. This is the single load-dedup mechanism: `repo.load` is a
   *  raw option-shaped loader that deliberately does NOT dedup (an
   *  id-only cache would silently merge a plain `repo.load(id)` with a
   *  concurrent `repo.load(id, {children})`), so the dedup lives here at
   *  the facade — one Block per id — where `read()`/`status()` also need
   *  the inflight/error state anyway. */
  private inflight: Promise<BlockData | null> | null = null

  /** Counts overlapping `load()` calls in flight. Drives `status()`'s
   *  'loading' branch — needed since the cache itself doesn't know who
   *  is currently loading what. */
  private loadingCount = 0

  /** Last error from a failed load. `status()` returns 'error' until the
   *  next successful load clears it. */
  private lastError: unknown = undefined

  constructor(repo: Repo, id: string) {
    this.repo = repo
    this.id = id
  }

  /** Stable Handle key — namespaced so a handle store dedup index could
   *  include Block (we don't currently register, but the key is part of
   *  the contract so the option remains open). */
  get key(): string { return `block:${this.id}` }

  // ──── Reads ────

  /** Sync live read; throws BlockNotLoadedError if the row isn't
   *  loaded, BlockNotFoundError if `repo.load` previously confirmed the
   *  row doesn't exist (§5.2) OR the cache currently holds a soft-
   *  deleted tombstone. The Block facade is the live-row surface; use
   *  `peekRaw()` for tombstone-aware inspection. */
  get data(): BlockData {
    const snap = this.peek()
    if (snap !== undefined && snap !== null) return snap
    if (snap === null) throw new BlockNotFoundError(this.id)
    throw new BlockNotLoadedError(this.id)
  }

  /** Live soft access (§5.2):
   *    undefined → not loaded yet
   *    null      → confirmed missing OR loaded tombstone
   *    BlockData → loaded live row */
  peek(): BlockData | undefined | null {
    const snap = liveSnapshot(this.repo.cache.getSnapshot(this.id))
    if (snap !== undefined) return snap
    if (this.repo.cache.isMissing(this.id)) return null
    return undefined
  }

  /** Tombstone-aware cache access. Most UI and query code should use
   *  `peek()`; this exists for lifecycle/debug paths that need to
   *  inspect the raw cached row shape without forcing a SQL read. */
  peekRaw(): BlockData | undefined | null {
    const snap = this.repo.cache.getSnapshot(this.id)
    if (snap !== undefined) return snap
    if (this.repo.cache.isMissing(this.id)) return null
    return undefined
  }

  /** Ensure loaded. Idempotent + dedup'd at the Block level so Suspense
   *  paths can throw a stable promise across renders. Returns null when
   *  the row doesn't exist.
   *
   *  Cache fast-path: if a live row is already in `BlockCache` we
   *  return synchronously without going to SQL. The cache is the
   *  source of truth post-tx (`repo.tx`'s commit pipeline writes it)
   *  and post-sync (`rowEventsTail`'s `applyIfNewer` keeps it
   *  current), so a redundant SQL read just costs a connection round-
   *  trip that contends with PowerSync's upload/download work. The
   *  hot path
   *  (keyboard navigation through `nextVisibleBlock` /
   *  `previousVisibleBlock`) does 2-3 of these per arrow press —
   *  occasionally blocked behind a slow sync drain (p99 ~600 ms in a
   *  big-DB profile). Mirrors `repo.exists`'s short-circuit and the
   *  `block.peek() ?? await block.load()` idiom.
   *
   *  The `confirmed-missing` marker is NOT a fast-path — `load()` is an
   *  "ensure loaded" operation, and a missing marker is just the cached
   *  result of a prior load. A caller asking again means they want SQL
   *  to re-verify; the marker may be stale relative to a sync that
   *  hasn't drained yet. */
  load(): Promise<BlockData | null> {
    const cached = this.repo.cache.getSnapshot(this.id)
    // Live snapshot only — fall through to SQL for tombstones so the
    // existing `repo.load` contract (returns null for soft-deleted +
    // markMissing as a side-effect) is preserved. Callers like
    // `RefPropertyEditor.blockMatchesTargetTypes` rely on `!data` to
    // mean "not a valid live row" and would otherwise treat a
    // tombstone as a real match.
    if (cached !== undefined && !cached.deleted) {
      // A successful load — symmetric with the SQL branch's
      // `lastError = undefined` on resolve. Without this, a prior
      // failed load leaves `lastError` set; it stays masked while the
      // snapshot is in cache (status checks `hasSnapshot` first), but
      // a later eviction surfaces the stale error through `status()` /
      // `read()` instead of returning to 'idle'.
      this.lastError = undefined
      return Promise.resolve(cached)
    }
    if (this.inflight) return this.inflight
    this.loadingCount++
    const p = this.repo.load(this.id)
      .then(
        (value) => {
          this.lastError = undefined
          return value
        },
        (err) => {
          this.lastError = err
          throw err
        },
      )
      .finally(() => {
        this.loadingCount = Math.max(0, this.loadingCount - 1)
        if (this.inflight === p) this.inflight = null
      })
    this.inflight = p
    return p
  }

  /** Subscribe to cache mutations for this id. Listener fires with the
   *  current live `BlockData | null` (null = confirmed missing, cached
   *  tombstone, or hard-deleted/missing). */
  subscribe(listener: (data: BlockData | null) => void): Unsubscribe {
    return this.repo.cache.subscribe(this.id, () => {
      const next = this.peek() ?? null
      listener(next)
    })
  }

  /** Suspense-path read. Returns the value if loaded; throws a Promise
   *  React can `await` if not loaded yet; throws the stored error if the
   *  last load failed. (Spec §5.1.) */
  read(): BlockData | null {
    const status = this.status()
    if (status === 'ready') {
      return this.peek() ?? null
    }
    if (status === 'error') throw this.lastError
    // 'loading' or 'idle': trigger / reuse a load and throw it.
    throw this.load()
  }

  /** Handle lifecycle status (spec §5.1):
   *    'ready'   — snapshot loaded OR row confirmed missing
   *    'loading' — at least one `load()` call in flight, no value yet
   *    'error'   — last load failed; cleared by the next successful load
   *    'idle'    — no load attempted yet, no snapshot in cache */
  status(): HandleStatus {
    if (this.repo.cache.hasSnapshot(this.id)) return 'ready'
    if (this.repo.cache.isMissing(this.id)) return 'ready'
    if (this.loadingCount > 0) return 'loading'
    if (this.lastError !== undefined) return 'error'
    return 'idle'
  }

  // ──── Properties ────

  /** Sync property read with codec.decode + schema defaultValue
   *  fallback. Throws BlockNotLoadedError if the row isn't loaded. */
  get<T>(schema: PropertySchema<T>): T {
    const data = this.data  // throws if not loaded
    const resolution = this.repo.propertySchemaResolverFor(data.workspaceId)
      .resolveBoundary(schema)
    if (resolution.status === 'identity-unavailable') return schema.defaultValue
    const resolvedSchema = resolution.schema
    const stored = data.properties[resolvedSchema.name]
    if (stored === undefined) return resolvedSchema.defaultValue
    return resolvedSchema.codec.decode(stored)
  }

  /** Like `get` but doesn't substitute the default — returns undefined
   *  when the property is absent. */
  peekProperty<T>(schema: PropertySchema<T>): T | undefined {
    const snap = this.peek()
    if (snap === undefined || snap === null) return undefined
    const resolution = this.repo.propertySchemaResolverFor(snap.workspaceId)
      .resolveBoundary(schema)
    if (resolution.status === 'identity-unavailable') return undefined
    const resolvedSchema = resolution.schema
    const stored = snap.properties[resolvedSchema.name]
    if (stored === undefined) return undefined
    return resolvedSchema.codec.decode(stored)
  }

  get types(): readonly string[] {
    const data = this.data
    return getBlockTypes(data)
  }

  hasType(typeId: string): boolean {
    return this.types.includes(typeId)
  }

  // ──── Tree relatives ────

  /** Reactive child-id list. Delegates to `repo.query.childIds({id})` —
   *  the LoaderHandle owns SQL + caching + invalidation, so call sites
   *  never need to ask the BlockCache about children directly.
   *  Imperative call sites do `await block.childIds.load()`; reactive
   *  ones use `useChildIds(block)` (which subscribes to the same
   *  handle).
   *
   *  Facade getters speak the visible/outline view (property field rows
   *  excluded, §9); drop to `repo.query.*` / `tx.childrenOf` for the
   *  structural everything-view. */
  get childIds(): LoaderHandle<string[]> {
    return this.repo.query.childIds({id: this.id, hidePropertyChildren: true})
  }

  /** Reactive children-rows list. Same shape as `childIds` but loads
   *  the full BlockData rows (per-row deps included), suitable for
   *  imperative tree walks that need content / properties without an
   *  extra `repo.block(id).load()` per child. Callers wanting Block
   *  facades do `(await block.children.load()).map(d => repo.block(d.id))`. */
  get children(): LoaderHandle<BlockData[]> {
    return this.repo.query.children({id: this.id, hidePropertyChildren: true})
  }

  /** Parent as Block, or null only if this block has no parent
   *  (workspace root). Returns the identity-stable facade from
   *  `repo.block(parentId)` regardless of whether the parent row is
   *  in cache — call `.load()` on the result if you need data.
   *
   *  Note: requires this block's own row to be in cache (so we know
   *  `parentId`). Returns null if this block isn't loaded yet — the
   *  caller is expected to have awaited a prior `load()` if it's
   *  reading parent imperatively. */
  get parent(): Block | null {
    const data = this.peek()
    if (data === undefined || data === null) return null
    if (data.parentId === null) return null
    return this.repo.block(data.parentId)
  }

  // ──── Single-block write sugar (each is a 1-mutator tx) ────

  /** Set a typed property. Each call is its own tx, equivalent to
   *  `repo.mutate.setProperty({id, schema, value})`.
   *
   *  Updater overload — `set(schema, current => next)` — reads the CURRENT
   *  committed value INSIDE the (serialized) write-transaction and writes
   *  the result, so concurrent single-key edits of a map/collection
   *  property compose instead of clobbering a stale snapshot. The function
   *  is never stored (it runs inside the tx; only its resolved value is
   *  written), so this stays replay-safe — and works because property
   *  values are serializable, so a value is never itself a function.
   *
   *  NOTE: unlike `get`, the updater receives `undefined` (NOT
   *  `schema.defaultValue`) when the property is absent, so handle the
   *  empty case yourself (e.g. `current => fn(current ?? new Map())`). */
  async set<T>(schema: PropertySchema<T>, value: T): Promise<void>
  async set<T>(
    schema: PropertySchema<T>,
    updater: (current: T | undefined) => T,
  ): Promise<void>
  async set<T>(
    schema: PropertySchema<T>,
    valueOrUpdater: T | ((current: T | undefined) => T),
  ): Promise<void> {
    if (typeof valueOrUpdater !== 'function') {
      await this.repo.mutate.setProperty({id: this.id, schema, value: valueOrUpdater})
      return
    }
    const updater = valueOrUpdater as (current: T | undefined) => T
    await this.repo.tx(async tx => {
      await tx.setProperty(this.id, schema, updater)
    }, {scope: schema.changeScope, description: `update property ${schema.name} on ${this.id}`})
  }

  async addType(typeId: string): Promise<void> {
    await this.repo.addType(this.id, typeId)
  }

  async removeType(typeId: string): Promise<void> {
    await this.repo.removeType(this.id, typeId)
  }

  async toggleType(typeId: string): Promise<void> {
    await this.repo.toggleType(this.id, typeId)
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
