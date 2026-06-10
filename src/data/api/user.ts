/** Tx-context user. Kept minimal — engine writes `user.id` into
 *  `tx_context.user_id` and into the per-row `created_by` / `updated_by`
 *  columns. Display-side User shape lives in `src/types.ts`; the data
 *  layer doesn't depend on it. */
export interface User {
  id: string
  name?: string
}

/** Author prefix for engine-minted speculative defaults — the
 *  deterministic-id bootstrap rows (settings, ui-state, the user page,
 *  kernel pages, daily-note seats, …). These are minted the moment a
 *  deterministic-id row is read-as-absent, *before* the server's
 *  authoritative version has materialized, so they must NOT outrank a
 *  real-but-older synced row under wall-clock LWW. Stamping their
 *  `updated_by` with this prefix is the conflict-resolution discriminator
 *  the reconcile gate reads to let such a pristine default yield to the
 *  server (see `decideStagingRow`).
 *
 *  Derived per-user (`system:<userId>`) rather than a single global
 *  sentinel so the write stays attributable — which device/user's
 *  bootstrap minted the row is still legible in `blocks_history` and in
 *  plain SQL — and so the reserved namespace can't collide with a real
 *  user id (those are opaque UUIDs and never start with `system:`). */
export const SYSTEM_AUTHOR_PREFIX = 'system:'

/** The system author for a given user — the value written to `updated_by`
 *  (NOT `created_by`) on that user's client when it mints a speculative
 *  deterministic-id default. `created_by` stays the real user: the prefix is
 *  contained to `updated_by`, the one field the gate reads and that
 *  self-clears to the real user on the first edit. */
export const systemAuthor = (userId: string): string => `${SYSTEM_AUTHOR_PREFIX}${userId}`

/** True iff `author` is any client's system author (an `updated_by` value
 *  that was engine-minted, not a real user edit). Display surfaces use this
 *  to badge / hide automatic writes; the reconcile gate uses the stronger
 *  *exact* match against the current user's system author (only this client's
 *  own pristine mint yields). */
export const isSystemAuthor = (author: string): boolean =>
  author.startsWith(SYSTEM_AUTHOR_PREFIX)
