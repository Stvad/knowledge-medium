/**
 * Public DB-maintenance entrypoints.
 *
 * Thin public surface over the kernel's `ANALYZE` helpers. The
 * implementation stays in `internals/clientSchema.ts` because it is
 * welded to the bootstrap-db internals it reads (blocks count,
 * `sqlite_stat1` baseline, drift thresholds); only the entrypoints are
 * promoted here so callers don't reach across the internals boundary.
 *
 * Every one of them MUST stay off the first-paint critical path — `ANALYZE`
 * is a multi-second pass on a large DB on the writer. See the docs on each
 * function.
 */
import { recordAnalyzeOwed, runAnalyzeTables } from './internals/clientSchema'
import { installedAnalyzeTableNames } from './localSchema'

export { runAnalyzeIfStale, runAnalyzeNow, runAnalyzeTables } from './internals/clientSchema'

type MaintenanceDb = Parameters<typeof runAnalyzeTables>[0]

/** Before a bulk block write: record a refresh as owed for every hot table the
 *  INSTALLED schema declares, plugin-owned ones included, so the next boot's
 *  check repays it if the writer's own refresh never lands. */
export const oweAnalyzeInstalledTables = (db: MaintenanceDb): Promise<void> =>
  recordAnalyzeOwed(db, installedAnalyzeTableNames())

/** After it: {@link runAnalyzeTables} over the same tables, settling what was owed. */
export const runAnalyzeInstalledTables = (db: MaintenanceDb): Promise<void> =>
  runAnalyzeTables(db, installedAnalyzeTableNames())
export type { AnalyzeResult } from './internals/clientSchema'
