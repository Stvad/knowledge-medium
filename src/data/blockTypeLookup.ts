/** Types of a bounded set of already-chosen blocks, chunked to what
 *  `core.blockTypesByIds` accepts. */
import type { Repo } from './repo'

/** `core.blockTypesByIds` validates `blockIds` at 200 entries, and a zod
 *  failure REJECTS — a caller asking for 201 rows would lose the whole
 *  search rather than some types. Both of today's display callers are far
 *  under it, but the alias fetch deliberately honours limits above its own
 *  ceiling (`Math.max(limit, …)`), so the ids reaching here are only ever
 *  as bounded as the caller. Chunk instead of trusting that. */
const BLOCK_TYPES_QUERY_MAX_IDS = 200

/** Types for a bounded set of already-chosen blocks, as a lookup keyed
 *  by block id. One `block_types` read per 200 results: the index is
 *  keyed `(block_id, type)`, so this is `ids.length` seeks and stays flat
 *  as the workspace grows — unlike folding the types into the fuzzy
 *  pre-filter, which would pay per *scanned* row rather than per
 *  *displayed* one. */
export const loadTypeIdsByBlock = async (
  repo: Repo,
  workspaceId: string,
  blockIds: readonly string[],
): Promise<Map<string, string[]>> => {
  const byBlock = new Map<string, string[]>()
  if (blockIds.length === 0) return byBlock
  const chunks: string[][] = []
  for (let start = 0; start < blockIds.length; start += BLOCK_TYPES_QUERY_MAX_IDS) {
    chunks.push(blockIds.slice(start, start + BLOCK_TYPES_QUERY_MAX_IDS))
  }
  // Concurrent: the chunks are independent reads, and the single-connection
  // VFS serialises them anyway — awaiting in sequence would only add
  // round-trip latency for the same work.
  const results = await Promise.all(
    chunks.map(chunk => repo.query.blockTypesByIds({workspaceId, blockIds: chunk}).load()),
  )
  for (const rows of results) {
    for (const row of rows) {
      const existing = byBlock.get(row.blockId)
      if (existing) existing.push(row.type)
      else byBlock.set(row.blockId, [row.type])
    }
  }
  return byBlock
}
