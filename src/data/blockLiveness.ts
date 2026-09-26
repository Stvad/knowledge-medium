/**
 * Distinguish "this block was DELETED" from "this client just doesn't have it".
 *
 * The Block facade deliberately can't: `peek()` and `load()` both return null
 * for a tombstone AND for a row that simply isn't here — and `repo.load`
 * markMissing's the id on the way, erasing even the cached tombstone. That
 * conflation is correct for rendering (neither is something you can show) but
 * wrong for any decision that turns on intent, where "someone deleted this" and
 * "this hasn't replicated yet" call for opposite behaviour:
 *
 *  - recovering a pane onto a fallback (right for a delete, loses a valid deep
 *    link for an unsynced row);
 *  - replacing rather than pushing a browser-history entry (same);
 *  - declining to resurrect a page from a get-or-create landing resolver.
 *
 * Reading the row directly is the only way to answer it, so this is the one
 * place that does. A missing row answers `false` — "not known to be deleted" —
 * which keeps every caller on the conservative side of the ambiguity.
 *
 * Note this asks the LOCAL database, so it can't distinguish a delete that has
 * synced from one that hasn't reached us. That's inherent to a local-first
 * client, and the conservative default is what covers it.
 */
import type { Repo } from './repo'

export const isBlockTombstoned = async (repo: Repo, blockId: string): Promise<boolean> => {
  const row = await repo.db.getOptional<{deleted: number}>(
    'SELECT deleted FROM blocks WHERE id = ?', [blockId],
  )
  return row?.deleted === 1
}

/** Batch form — one query for several ids. True if ANY is a tombstone. */
export const anyBlockTombstoned = async (
  repo: Repo,
  blockIds: readonly string[],
): Promise<boolean> => {
  if (blockIds.length === 0) return false
  const placeholders = blockIds.map(() => '?').join(', ')
  const rows = await repo.db.getAll<{deleted: number}>(
    `SELECT deleted FROM blocks WHERE id IN (${placeholders})`, [...blockIds],
  )
  return rows.some(row => row.deleted === 1)
}

/** Batch form — of `blockIds`, the ones NOT known to be tombstoned: either
 *  genuinely live, or simply missing locally (see the module doc's
 *  "missing ≠ deleted" default — the conservative side keeps a possibly-
 *  unsynced id in the survivors list rather than dropping it). Preserves
 *  the input order.
 *
 *  Used by `pasteAsMoveImpl` to move the survivors of a cut rather than
 *  refusing the whole batch because one id was deleted since.
 *
 *  Reads in chunks of `LIVENESS_CHUNK`, mirroring `FIELD_PROBE_CHUNK` in
 *  `repo.ts`: one bound parameter per id would otherwise blow SQLite's
 *  bound-parameter cap on a large multi-select cut. */
const LIVENESS_CHUNK = 500

export const liveBlockIds = async (
  repo: Repo,
  blockIds: readonly string[],
): Promise<string[]> => {
  if (blockIds.length === 0) return []
  const tombstoned = new Set<string>()
  for (let i = 0; i < blockIds.length; i += LIVENESS_CHUNK) {
    const chunk = blockIds.slice(i, i + LIVENESS_CHUNK)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = await repo.db.getAll<{id: string; deleted: number}>(
      `SELECT id, deleted FROM blocks WHERE id IN (${placeholders})`, [...chunk],
    )
    for (const row of rows) {
      if (row.deleted === 1) tombstoned.add(row.id)
    }
  }
  return blockIds.filter(id => !tombstoned.has(id))
}
