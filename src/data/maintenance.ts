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
import { runAnalyzeTables } from './internals/clientSchema'
import { installedAnalyzeTableNames } from './localSchema'

export { runAnalyzeIfStale, runAnalyzeNow, runAnalyzeTables } from './internals/clientSchema'

/** {@link runAnalyzeTables} over every hot table the INSTALLED schema declares,
 *  plugin-owned ones included, for a bulk block writer that grew them. */
export const runAnalyzeInstalledTables = (db: Parameters<typeof runAnalyzeTables>[0]): Promise<void> =>
  runAnalyzeTables(db, installedAnalyzeTableNames())
export type { AnalyzeResult } from './internals/clientSchema'
