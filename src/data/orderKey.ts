/**
 * Order-key helpers (spec §4.1, §16.12).
 *
 * Backed by `fractional-indexing-jittered`'s base62 character set. Two
 * concurrent clients inserting between the same neighbors will most
 * likely compute distinct keys (jitter); residual collisions resolve
 * via the `(order_key, id)` secondary sort the SUBTREE_SQL CTE +
 * `idx_blocks_parent_order` index both rely on.
 *
 * Why base62 + this lib over plain `fractional-indexing`:
 *   - Jittering reduces collision rate at no measurable cost.
 *   - Base62 (`0-9A-Za-z`) is alphanumeric, so order-keys can't contain
 *     the `!` (0x21) separator the path-encoding CTE uses (§11.1).
 *   - All base62 chars sort lex-greater than `!`, so `<order_key>!hex(id)/`
 *     gives the right sibling order for prefix-related keys (e.g. `a` vs
 *     `aa`) — see the v4.25 separator analysis in §11.1 of the spec.
 *
 * `null` values mean "no neighbor on this side" — i.e. the new key
 * goes at the start or end of the list.
 */

import {
  generateJitteredKeyBetween,
  generateNJitteredKeysBetween,
} from 'fractional-indexing-jittered'

/** A new key strictly between `lower` and `upper`. Pass `null` for the
 *  end of the list.
 *    keyBetween(null, null)  → first key when there are no siblings
 *    keyBetween(null, 'A0')  → before A0
 *    keyBetween('A0', null)  → after A0
 *    keyBetween('A0', 'A1')  → strictly between A0 and A1
 */
export const keyBetween = (
  lower: string | null,
  upper: string | null,
): string => generateJitteredKeyBetween(lower, upper)

/** N new keys strictly between `lower` and `upper`. Returned in
 *  ascending order; safe to insert as a contiguous run of siblings. */
export const keysBetween = (
  lower: string | null,
  upper: string | null,
  n: number,
): string[] => generateNJitteredKeysBetween(lower, upper, n)

/** First key — for an empty sibling list, or to put a new row at the
 *  very start. */
export const keyAtStart = (firstExisting: string | null = null): string =>
  keyBetween(null, firstExisting)

/** Last key — for an empty sibling list, or to put a new row at the
 *  very end. */
export const keyAtEnd = (lastExisting: string | null = null): string =>
  keyBetween(lastExisting, null)
