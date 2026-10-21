import { vi } from 'vitest'

/** What `OPFSWriteAheadVFS` answers `PRAGMA wal_checkpoint`: one cell, named and
 *  valued as its approximate un-checkpointed page count. */
export const vfsCheckpointAnswer = (pages: number) => ({rows: {_array: [{[String(pages)]: String(pages)}]}})

/** Make `db` answer as `OPFSWriteAheadVFS` with a log far past any limit, and
 *  hand each truncate checkpoint to `onCheckpoint` instead of SQLite; every
 *  other statement runs for real. Restore the returned spy after. */
export const spyOnOverfullLog = (
  db: {execute: (sql: string, params?: unknown[]) => Promise<unknown>},
  onCheckpoint: () => void,
) => {
  const execute = db.execute.bind(db)
  return vi.spyOn(db, 'execute').mockImplementation(async (sql, params) => {
    if (sql === 'PRAGMA wal_checkpoint=noop') return vfsCheckpointAnswer(9_999_999)
    if (sql === 'PRAGMA wal_checkpoint=truncate') { onCheckpoint(); return undefined }
    return execute(sql, params)
  })
}
