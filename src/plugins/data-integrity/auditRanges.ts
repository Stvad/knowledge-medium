import type { AuditDb } from './audit.js'

// Both tables have SQLite-assigned rowids. Bound the work between activity
// checks without sorting text IDs or walking offsets through earlier pages.
const ROWS_PER_RANGE = 2048

export const forEachAuditRange = async (
  db: AuditDb, table: 'blocks' | 'block_references',
  visit: (first: number, last: number) => Promise<void>,
): Promise<void> => {
  const [bounds] = await db.getAll<{ first: number | null; last: number | null }>(
    `SELECT (SELECT min(rowid) FROM ${table}) AS first,
            (SELECT max(rowid) FROM ${table}) AS last`,
  )
  if (bounds?.first == null || bounds.last == null) return
  let first = bounds.first
  const end = bounds.last
  for (;;) {
    const last = Math.min(first + ROWS_PER_RANGE - 1, end)
    await visit(first, last)
    if (last === end) break
    const [next] = await db.getAll<{ first: number | null }>(
      `SELECT min(rowid) AS first FROM ${table} WHERE rowid > ? AND rowid <= ?`, [last, end],
    )
    if (next?.first == null) break
    first = next.first
  }
}
