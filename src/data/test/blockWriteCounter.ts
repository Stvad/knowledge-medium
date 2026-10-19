import type { PowerSyncDatabase } from '@powersync/node'

/** A test-only count of every write that reaches `blocks`, for asserting that a
 *  step wrote nothing. Neither `row_events` nor the row version can say that:
 *  an update that moves only `updated_at` logs no event, and one that assigns
 *  every column its current value moves nothing at all. */
const COUNTER_SQL = [
  'CREATE TABLE IF NOT EXISTS test_block_writes (block_id TEXT PRIMARY KEY, n INTEGER NOT NULL)',
  ...([['insert', 'NEW'], ['update', 'NEW'], ['delete', 'OLD']] as const).map(([op, row]) => `
    CREATE TRIGGER IF NOT EXISTS test_block_writes_${op} AFTER ${op.toUpperCase()} ON blocks
    BEGIN
      INSERT INTO test_block_writes (block_id, n) VALUES (${row}.id, 1)
        ON CONFLICT (block_id) DO UPDATE SET n = n + 1;
    END`),
]

/** Once per database; `resetTestDb` keeps the counter, and readings are only
 *  ever compared before and after a step. */
export const installBlockWriteCounter = async (db: PowerSyncDatabase): Promise<void> => {
  for (const sql of COUNTER_SQL) await db.execute(sql)
}

/** Writes so far to `blockId`, or to every block when it is omitted. */
export const blockWrites = async (db: PowerSyncDatabase, blockId?: string): Promise<number> =>
  blockId === undefined
    ? (await db.get<{n: number}>('SELECT COALESCE(SUM(n), 0) AS n FROM test_block_writes')).n
    : (await db.getOptional<{n: number}>('SELECT n FROM test_block_writes WHERE block_id = ?', [blockId]))?.n ?? 0
