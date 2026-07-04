/**
 * Pure decisions over the generation ledger — an install-ordered list of
 * BUILD_IDs (newest last). The worker (src/sw/sw.ts) owns the impure I/O
 * (reading/writing the ledger Response in the meta cache); the retention math
 * lives here so it unit-tests without a cache.
 *
 * Each deploy is an immutable generation with its own km-shell-<id> /
 * km-assets-<id> caches. On activate we keep the most recent `keep`
 * generations (so a tab still on a prior build has a consistent cache to read
 * from) and GC the rest.
 */

/** The ids to KEEP: the most recent `keep`, newest-last order preserved. */
export const computeKeepIds = (ledger: string[], keep: number): string[] =>
  ledger.slice(Math.max(0, ledger.length - keep))

/**
 * The ids that have aged out of the keep-window and whose caches should be
 * GC'd. Disjoint from computeKeepIds; empty when the ledger fits the window.
 */
export const computeExpiredIds = (ledger: string[], keep: number): string[] =>
  ledger.slice(0, Math.max(0, ledger.length - keep))
