import type { QueryReadDb } from './api/query'

/** Both index tails matter: bulk downloads insert new blocks without logging their arrival in row_events. */
export async function blockChangeCursor(db: Pick<QueryReadDb, 'get'>): Promise<string> {
  const row = await db.get<{cursor: string}>(`
    SELECT coalesce((SELECT max(id) FROM row_events), 0)
        || '/' || coalesce((SELECT max(rowid) FROM blocks), 0) AS cursor`)
  return row.cursor
}
