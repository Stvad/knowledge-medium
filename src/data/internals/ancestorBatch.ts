/**
 * Request coalescing for the ancestor walk (`readBatch.ts`).
 *
 * One handle per id (see `core.ancestors`) would otherwise cost one SQL
 * statement per id. So every walk that starts in the same microtask is
 * answered by ONE `manyAncestorsSql` statement.
 */

import type { QueryReadDb } from '@/data/api'
import type { BlockRow } from '@/data/blockSchema'
import { ReadBatcher, readBatcherPerDb } from './readBatch'
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

const batcherFor = readBatcherPerDb(db => new ReadBatcher<void, AncestorWalk>(db, {
  maxIdsPerStatement: MAX_IDS_PER_STATEMENT,
  read: async (_key, ids) => {
    const rows = await db.getAll<AncestorChainRow>(manyAncestorsSql(ids.length), [...ids])
    const byStart = new Map<string, AncestorChainRow[]>()
    for (const row of rows) {
      const walk = byStart.get(row.chain_start_id)
      if (walk) walk.push(row)
      else byStart.set(row.chain_start_id, [row])
    }
    // An id with no rows at all is a block that does not exist or is
    // soft-deleted — the ONE place that reading is made.
    return id => {
      const rowsForId = byStart.get(id)
      return rowsForId ? walkFromRows(rowsForId) : NO_WALK
    }
  },
}))

/** The walk for `id`: its leaf-to-root chain with deleted rows filtered
 *  out, and the parent it stopped at if it did. Calls for the same id in
 *  one microtask are one read, so the result is shared between those
 *  callers — hence `readonly` throughout, which is the contract and not
 *  a formality. */
export const ancestorWalk = (
  db: QueryReadDb,
  id: string,
): Promise<AncestorWalk> => batcherFor(db).request(id)
