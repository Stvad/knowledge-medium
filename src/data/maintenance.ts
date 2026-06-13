/**
 * Public DB-maintenance entrypoints.
 *
 * Thin public surface over the kernel's `ANALYZE` helpers. The
 * implementation stays in `internals/clientSchema.ts` because it is
 * welded to the bootstrap-db internals it reads (blocks count,
 * `sqlite_stat1` baseline, drift thresholds); only the entrypoints are
 * promoted here so callers don't reach across the internals boundary.
 *
 * Both helpers MUST be scheduled off the first-paint critical path
 * (idle / post-sync) — `ANALYZE` is a multi-second pass on a large DB on
 * the single SQLite worker. See the docs on each function.
 */
export { runAnalyzeIfStale, runAnalyzeNow } from './internals/clientSchema'
export type { AnalyzeResult } from './internals/clientSchema'
