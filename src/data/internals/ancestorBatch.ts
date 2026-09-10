/**
 * Request coalescing for the ancestor walk.
 *
 * `core.ancestors({id})` is the cache and invalidation unit for one
 * block's parent chain: one handle per id, keyed by that id, invalidated
 * by that chain's own row deps. A surface showing many blocks therefore
 * holds many handles, and a change to the SET it shows costs only the
 * ids that entered it — the ids already held stay resolved.
 *
 * What that shape would otherwise cost is one SQL statement per id, on a
 * connection with no read/read concurrency (`OPFSCoopSyncVFS` runs one
 * connection behind a single-slot mutex). So every walk that starts in
 * the same microtask is answered by ONE `manyAncestorsSql` statement,
 * which is what makes per-id the right grain rather than a regression
 * against the batched query it replaces.
 *
 * Purely a transport: it holds no resolved chains between flushes, so
 * nothing here can serve a stale one. Caching is the handle store's job.
 */

import type { QueryReadDb } from '@/data/api'
import type { BlockRow } from '@/data/blockSchema'
import { manyAncestorsSql } from './treeQueries'

export type AncestorChainRow = BlockRow & {chain_start_id: string}

/** Ids per statement. One SQL bind per id, so this is far under SQLite's
 *  variable cap; it is set at the size of a large visible set so that
 *  chunking is the degenerate path a caller reaches only by asking for
 *  more chains than any surface renders at once. */
const MAX_IDS_PER_STATEMENT = 100

interface Waiter {
  resolve: (rows: AncestorChainRow[]) => void
  reject: (error: unknown) => void
}

class AncestorBatcher {
  /** Ids awaiting the next flush. Same id twice in a tick is one read. */
  private waiting = new Map<string, Waiter[]>()
  private scheduled = false

  constructor(private readonly db: QueryReadDb) {}

  chainFor(id: string): Promise<AncestorChainRow[]> {
    return new Promise<AncestorChainRow[]>((resolve, reject) => {
      const existing = this.waiting.get(id)
      if (existing) {
        existing.push({resolve, reject})
        return
      }
      this.waiting.set(id, [{resolve, reject}])
      // Work avoided, not a correctness guard: a second flush in the
      // same tick finds the queue already drained and issues nothing.
      if (this.scheduled) return
      this.scheduled = true
      queueMicrotask(() => { void this.flush() })
    })
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
        for (const id of chunk) byStart.set(id, [])
        for (const row of rows) byStart.get(row.chain_start_id)?.push(row)
        for (const id of chunk) {
          const chain = byStart.get(id) ?? []
          for (const waiter of batch.get(id) ?? []) waiter.resolve(chain)
        }
      } catch (error) {
        // Scoped to the chunk: an id in a later chunk is a separate
        // statement and still gets its chain.
        for (const id of chunk) {
          for (const waiter of batch.get(id) ?? []) waiter.reject(error)
        }
      }
    }
  }
}

/** One batcher per database. `WeakMap` rather than a field on `Repo`
 *  because the coalescing window is the microtask, not the Repo: two
 *  Repos over one connection are still one queue. */
const batchers = new WeakMap<QueryReadDb, AncestorBatcher>()

/** The leaf-to-root chain for `id`, excluding `id` itself, deleted rows
 *  filtered out. Rows for the same id in one microtask are one read, and
 *  the returned array is shared between those callers — read it, don't
 *  mutate it. */
export const ancestorChainRows = (
  db: QueryReadDb,
  id: string,
): Promise<AncestorChainRow[]> => {
  let batcher = batchers.get(db)
  if (!batcher) {
    batcher = new AncestorBatcher(db)
    batchers.set(db, batcher)
  }
  return batcher.chainFor(id)
}
