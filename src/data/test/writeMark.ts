import type { PowerSyncDatabase } from '@powersync/node'

/** Readings that move whenever a write reaches `blocks`, for asserting that a
 *  step wrote nothing. `row_events` alone is not one: an update that moves
 *  only the row version logs no event, so the version is read as well. */
export const blocksWriteMark = async (db: PowerSyncDatabase): Promise<string> => {
  const row = await db.get<{events: number; versions: number}>(
    `SELECT (SELECT COALESCE(MAX(id), 0) FROM row_events) AS events,
            (SELECT COALESCE(SUM(updated_at), 0) FROM blocks) AS versions`,
  )
  return `${row.events}/${row.versions}`
}

export const blockWriteMark = async (db: PowerSyncDatabase, blockId: string): Promise<string> => {
  const row = await db.get<{events: number; version: number | null}>(
    `SELECT (SELECT COALESCE(MAX(id), 0) FROM row_events WHERE block_id = ?) AS events,
            (SELECT updated_at FROM blocks WHERE id = ?) AS version`,
    [blockId, blockId],
  )
  return `${row.events}/${row.version}`
}
