/**
 * The sync observer's half of keeping `sqlite_stat1` honest. `PRAGMA optimize`
 * re-analyzes a table only past ~10x drift, so growth below that is refreshed
 * only when whoever grew the table records it as owed. A local bulk writer
 * does (`oweAnalyzeInstalledTables`); rows that arrive by sync are inserted
 * here, so here is where that growth is recorded. The next `runAnalyzeIfStale`
 * repays it.
 */

import { recordAnalyzeOwed } from '@/data/internals/clientSchema.js'
import type { PowerSyncDb } from '@/data/internals/commitPipeline.js'
import { installedAnalyzeTableNames } from '@/data/localSchema.js'
import type { MaterializeOutcome } from './materialize.js'

/** Inserted rows, as a share of the row count `sqlite_stat1` claims for
 *  `blocks`, past which the stats are owed a refresh. */
export const SYNC_GROWTH_OWES_ANALYZE_FRACTION = 0.25

const HAS_STAT1_SQL = `SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_stat1'`

const SELECT_BLOCKS_STAT_ROWS_SQL = `
  SELECT CAST(stat AS INTEGER) AS rows FROM sqlite_stat1
   WHERE tbl = 'blocks' AND idx = 'sqlite_autoindex_blocks_1'
`

/** The row count the stats claim for `blocks`; 0 when it has none, including
 *  a database never analyzed at all, which has no `sqlite_stat1` table. */
const readBlocksStatRows = async (db: PowerSyncDb): Promise<number> => {
  if (!await db.getOptional(HAS_STAT1_SQL)) return 0
  return (await db.getOptional<{rows: number}>(SELECT_BLOCKS_STAT_ROWS_SQL))?.rows ?? 0
}

/** Counts the rows each materialize pass INSERTED into `blocks`, and records an
 *  ANALYZE as owed whenever they reach {@link SYNC_GROWTH_OWES_ANALYZE_FRACTION}
 *  of the stats' row count. Each record restarts the count against a fresh read
 *  of the stats, which a repaid ANALYZE will have moved.
 *
 *  Per observer lifetime, not persisted: a bulk change synced across several
 *  sessions, each below the fraction, is not recorded. Accepted: a bulk change
 *  arrives in one or two sessions, and the miss costs plan quality, never data.
 *
 *  No stats counts as zero rows: a device's first sync owes one ANALYZE. */
export const createSyncGrowthAnalyzeOwer = (db: PowerSyncDb) => {
  let inserted = 0
  let statRows: Promise<number> | null = null

  return async (outcome: MaterializeOutcome): Promise<void> => {
    for (const {before, after} of outcome.snapshots.values()) {
      if (before === null && after !== null) inserted++
    }
    if (inserted === 0) return
    // A failed read is not cached, so the next window retries it.
    statRows ??= readBlocksStatRows(db).catch((err: unknown) => {
      statRows = null
      throw err
    })
    const rows = await statRows
    if (inserted < rows * SYNC_GROWTH_OWES_ANALYZE_FRACTION) return
    inserted = 0
    statRows = null
    await recordAnalyzeOwed(db, installedAnalyzeTableNames())
  }
}
