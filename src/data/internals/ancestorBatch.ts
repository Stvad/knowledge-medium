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

/** Ids per statement. One SQL bind per id, and SQLite caps bound
 *  parameters at a build-dependent number — 999 on older builds, 32766
 *  since 3.32 — that nothing here can read back, so the bound sits under
 *  the old floor. Same figure and same reason as `STAGING_READ_CHUNK` in
 *  `syncObserver/materialize.ts`.
 *
 *  A caller above it IS split, and the recents feed reaches that by
 *  paging ("Show older" adds 200 rows a click, so the third page is two
 *  statements). Declined raising it to the modern cap: the failure modes
 *  are not symmetric — an over-limit statement throws and takes the whole
 *  feed with it, while an extra chunk costs one round trip on a click
 *  that already pays for a 600-chain recursive walk. Splitting is also
 *  what an unchunked caller lacked before this existed, which is the
 *  latent throw at ~1000 rows that this removes. */
const MAX_IDS_PER_STATEMENT = 500

/** Shared, so an id with no ancestors costs no allocation. */
const NO_ANCESTORS: readonly AncestorChainRow[] = Object.freeze([])

interface Waiter {
  resolve: (rows: readonly AncestorChainRow[]) => void
  reject: (error: unknown) => void
}

class AncestorBatcher {
  /** Ids awaiting the next flush. Same id twice in a tick is one read. */
  private waiting = new Map<string, Waiter[]>()
  private scheduled = false

  constructor(private readonly db: QueryReadDb) {}

  chainFor(id: string): Promise<readonly AncestorChainRow[]> {
    return new Promise<readonly AncestorChainRow[]>((resolve, reject) => {
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
        for (const row of rows) {
          const chain = byStart.get(row.chain_start_id)
          if (chain) chain.push(row)
          else byStart.set(row.chain_start_id, [row])
        }
        // An id with no rows is a block that has no ancestors, or none
        // the walk could reach — the ONE place that reading is made, so
        // a waiter never sees `undefined` for an id it asked about.
        for (const id of chunk) {
          const chain = byStart.get(id) ?? NO_ANCESTORS
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

/** One batcher per read surface, which in practice is one per `Repo` —
 *  `Repo` wraps its database in a per-instance metrics proxy, so two
 *  Repos over one connection key here separately and each gets its own
 *  queue. That costs one extra statement in the only arrangement that
 *  produces it (a test sharing a db between Repos) and nothing in the app,
 *  which has one Repo. `WeakMap` rather than a `Repo` field so the walk
 *  stays reachable from a resolver holding only `ctx.db`. */
const batchers = new WeakMap<QueryReadDb, AncestorBatcher>()

/** The leaf-to-root chain for `id`, excluding `id` itself, deleted rows
 *  filtered out. Rows for the same id in one microtask are one read, so
 *  the returned array is shared between those callers — hence `readonly`,
 *  which is the contract and not a formality. */
export const ancestorChainRows = (
  db: QueryReadDb,
  id: string,
): Promise<readonly AncestorChainRow[]> => {
  let batcher = batchers.get(db)
  if (!batcher) {
    batcher = new AncestorBatcher(db)
    batchers.set(db, batcher)
  }
  return batcher.chainFor(id)
}
