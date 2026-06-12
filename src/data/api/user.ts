/** Tx-context user. Kept minimal — engine writes `user.id` into
 *  `tx_context.user_id` and into the per-row `created_by` / `updated_by`
 *  columns. Display-side User shape lives in `src/types.ts`; the data
 *  layer doesn't depend on it. */
export interface User {
  id: string
  name?: string
}

/** Author prefix that engine-minted speculative defaults *used to* stamp into
 *  `updated_by`. HISTORICAL: the reconcile gate no longer reads provenance —
 *  pristineness is now `updated_at === 0` (the sentinel set by `buildNewBlockRow`
 *  for a `systemMint`), and new mints stamp the real user in `updated_by`. A
 *  one-time post-upgrade migration rewrites surviving `system:<uid>` rows back
 *  to `<uid>` and zeroes their `updated_at`.
 *
 *  Retained only as a DISPLAY shim: pre-migration rows and time-travel /
 *  undo over historical `row_events` / `blocks_history` snapshots still carry
 *  `system:<uid>` in `updated_by`, and `isSystemAuthor` lets those render
 *  sanely ("System"). Derived per-user (`system:<userId>`) so the historical
 *  write stays attributable and can't collide with a real (opaque-UUID) id. */
export const SYSTEM_AUTHOR_PREFIX = 'system:'

/** The historical system author for a user. No longer written by live code
 *  (mints now use the real user + the `updated_at = 0` sentinel); kept as the
 *  constructor paired with `isSystemAuthor` (the live display shim) — used to
 *  build / recognize the `system:<uid>` values pre-migration rows still carry. */
export const systemAuthor = (userId: string): string => `${SYSTEM_AUTHOR_PREFIX}${userId}`

/** True iff `author` is an engine-minted historical system author. DISPLAY
 *  shim only (badge / "System" rendering for pre-migration + time-travel rows).
 *  The reconcile gate no longer reads this — it uses `updated_at === 0`. */
export const isSystemAuthor = (author: string): boolean =>
  author.startsWith(SYSTEM_AUTHOR_PREFIX)
