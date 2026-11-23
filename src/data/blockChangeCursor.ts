import type { QueryReadDb } from './api/query'

/** The latest committed block change, including sync writes. An extension may sort on any block in the graph. */
export async function blockChangeCursor(db: Pick<QueryReadDb, 'getOptional'>): Promise<number> {
  const row = await db.getOptional<{id: number}>('SELECT id FROM row_events ORDER BY id DESC LIMIT 1')
  return row?.id ?? 0
}
