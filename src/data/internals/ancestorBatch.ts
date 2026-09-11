/**
 * Request coalescing for the ancestor walk.
 *
 * One handle per id (see `core.ancestors`) would otherwise cost one SQL
 * statement per id, on a connection with no read/read concurrency
 * (`OPFSCoopSyncVFS` runs one connection behind a single-slot mutex). So
 * every walk that starts in the same microtask is answered by ONE
 * `manyAncestorsSql` statement.
 *
 * Purely a transport: it holds no resolved chains between flushes, so
 * nothing here can serve a stale one. Caching is the handle store's job.
 */

import type { QueryReadDb } from '@/data/api'
import type { BlockRow } from '@/data/blockSchema'
import { MAX_IDS_PER_IN_CLAUSE } from './sqlBinds'
import { manyAncestorsSql } from './treeQueries'

export type AncestorChainRow = BlockRow & {chain_start_id: string; depth: number}

/** One block's walk. `chain` is leaf-to-root and excludes the block
 *  itself.
 *
 *  `stoppedAtParentId` is what makes an EMPTY chain readable: a walk
 *  stopped at a parent it cannot see returns the same nothing as a block
 *  with no parent, and this names the difference. `null` means the walk
 *  reached a root — or that the block itself is gone, which names no
 *  parent either. */
export interface AncestorWalk {
  readonly stoppedAtParentId: string | null
  readonly chain: readonly AncestorChainRow[]
}

/** One SQL bind per id, so the shared ceiling applies directly. Callers
 *  above it are split — the recents feed reaches that by paging.
 *  Declined raising it to the modern cap: an over-limit statement throws
 *  and takes the whole feed with it, an extra chunk costs one round
 *  trip. */
const MAX_IDS_PER_STATEMENT = MAX_IDS_PER_IN_CLAUSE

/** Shared, so an id whose row is gone costs no allocation. */
const NO_WALK: AncestorWalk = Object.freeze({stoppedAtParentId: null, chain: Object.freeze([])})

/** One id's rows, depth-ascending and therefore seed-first. The seed is
 *  split off the chain, and the topmost row's parent edge is the walk's
 *  own answer to whether it reached a root: the row it names is missing
 *  from the result precisely because the walk could not include it. */
const walkFromRows = (rows: readonly AncestorChainRow[]): AncestorWalk => ({
  stoppedAtParentId: rows[rows.length - 1].parent_id,
  chain: rows.slice(1),
})

/** One id's pending read. Every caller for that id in a tick awaits the
 *  same promise, so settling it settles all of them. */
interface Pending {
  promise: Promise<AncestorWalk>
  resolve: (walk: AncestorWalk) => void
  reject: (error: unknown) => void
}

const pending = (): Pending => {
  let resolve!: (walk: AncestorWalk) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<AncestorWalk>((res, rej) => { resolve = res; reject = rej })
  return {promise, resolve, reject}
}

class AncestorBatcher {
  /** Ids awaiting the next flush. Same id twice in a tick is one read. */
  private waiting = new Map<string, Pending>()
  private scheduled = false

  constructor(private readonly db: QueryReadDb) {}

  walkFor(id: string): Promise<AncestorWalk> {
    const existing = this.waiting.get(id)
    if (existing) return existing.promise

    const entry = pending()
    this.waiting.set(id, entry)
    // Work avoided, not a correctness guard: a second flush in the
    // same tick finds the queue already drained and issues nothing.
    if (!this.scheduled) {
      this.scheduled = true
      queueMicrotask(() => { void this.flush() })
    }
    return entry.promise
  }

  private async flush(): Promise<void> {
    // Taken before the first await, so ids arriving while a statement is
    // in flight open the NEXT batch rather than joining one that has
    // already been read.
    const batch = this.waiting
    this.waiting = new Map()
    this.scheduled = false

    const ids = [...batch.keys()]
    for (let start = 0; start < ids.length; start += MAX_IDS_PER_STATEMENT) {
      const chunk = ids.slice(start, start + MAX_IDS_PER_STATEMENT)
      try {
        const rows = await this.db.getAll<AncestorChainRow>(
          manyAncestorsSql(chunk.length), chunk,
        )
        const byStart = new Map<string, AncestorChainRow[]>()
        for (const row of rows) {
          const walk = byStart.get(row.chain_start_id)
          if (walk) walk.push(row)
          else byStart.set(row.chain_start_id, [row])
        }
        // An id with no rows at all is a block that does not exist or is
        // soft-deleted — the ONE place that reading is made, so a caller
        // never sees `undefined` for an id it asked about.
        for (const id of chunk) {
          const rowsForId = byStart.get(id)
          batch.get(id)!.resolve(rowsForId ? walkFromRows(rowsForId) : NO_WALK)
        }
      } catch (error) {
        // Scoped to the chunk: an id in a later chunk is a separate
        // statement and still gets its chain.
        for (const id of chunk) batch.get(id)!.reject(error)
      }
    }
  }
}

/** One batcher per read surface, which is one per `Repo` — `Repo` wraps
 *  its database in a per-instance metrics proxy, so two Repos over one
 *  connection do NOT share a queue. `WeakMap` rather than a `Repo` field
 *  so the walk stays reachable from a resolver holding only `ctx.db`. */
const batchers = new WeakMap<QueryReadDb, AncestorBatcher>()

/** The walk for `id`: its leaf-to-root chain with deleted rows filtered
 *  out, and the parent it stopped at if it did. Calls for the same id in
 *  one microtask are one read, so the result is shared between those
 *  callers — hence `readonly` throughout, which is the contract and not
 *  a formality. */
export const ancestorWalk = (
  db: QueryReadDb,
  id: string,
): Promise<AncestorWalk> => {
  let batcher = batchers.get(db)
  if (!batcher) {
    batcher = new AncestorBatcher(db)
    batchers.set(db, batcher)
  }
  return batcher.walkFor(id)
}
