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

// ──── Tie-safe positioning (A1) ────
//
// Two adjacent siblings sharing an `order_key` is a supported on-disk state
// (the `(parent_id, order_key, id)` index is non-unique; ties arrive via
// import, `setOrderKey`, and residual jitter collisions under concurrent sync —
// see the module header). When the immediate neighbours on both sides of an
// insertion gap share a key, no key sorts strictly between them, and
// `keyBetween(equal, equal)` throws `"<key> >= <key>"` — rolling back the whole
// tx and silently dropping the user's edit.
//
// The helpers below take the FULL sibling key list (ascending `(order_key, id)`
// order — exactly what `tx.childrenOf` returns) and an anchor index, then widen
// the equal bound to the nearest DISTINCT key on the far side of the tied run.
// The anchored bound stays pinned, so the result lands deterministically just
// outside the tied run on the requested side (after it for `*After`, before it
// for `*Before`) while preserving a strictly-ordered key. Non-tie inputs reduce
// to the plain `keysBetween` the call sites used before.

/** The nearest key strictly greater than `keys[anchor]` at or after `anchor+1`.
 *  Since `keys` is ascending, everything past `anchor` is `>= keys[anchor]`, so
 *  this just skips the tied run sharing the anchor's key. `null` = the anchor's
 *  run reaches the end of the list. */
const nextDistinctAfter = (keys: readonly string[], anchor: number): string | null => {
  const anchorKey = keys[anchor]
  for (let i = anchor + 1; i < keys.length; i++) {
    if (keys[i] > anchorKey) return keys[i]
  }
  return null
}

/** The nearest key strictly less than `keys[anchor]` at or before `anchor-1`.
 *  Since `keys` is ascending, everything before `anchor` is `<= keys[anchor]`,
 *  so this skips the tied run sharing the anchor's key. `null` = the anchor's
 *  run reaches the start of the list. */
const prevDistinctBefore = (keys: readonly string[], anchor: number): string | null => {
  const anchorKey = keys[anchor]
  for (let i = anchor - 1; i >= 0; i--) {
    if (keys[i] < anchorKey) return keys[i]
  }
  return null
}

/** `n` keys strictly after the sibling at `anchor` and before the next distinct
 *  key — tie-safe. The lower bound stays pinned to the anchor's key, so the run
 *  always sorts after the anchor (and after any siblings tied with it). */
export const keysAfterIndex = (
  keys: readonly string[],
  anchor: number,
  n: number,
): string[] => keysBetween(keys[anchor], nextDistinctAfter(keys, anchor), n)

/** `n` keys strictly before the sibling at `anchor` and after the previous
 *  distinct key — tie-safe. The upper bound stays pinned to the anchor's key,
 *  so the run always sorts before the anchor (and before any siblings tied with
 *  it). */
export const keysBeforeIndex = (
  keys: readonly string[],
  anchor: number,
  n: number,
): string[] => keysBetween(prevDistinctBefore(keys, anchor), keys[anchor], n)

/** A single key strictly after the sibling at `anchor` — tie-safe. */
export const keyAfterIndex = (keys: readonly string[], anchor: number): string =>
  keysAfterIndex(keys, anchor, 1)[0]

/** A single key strictly before the sibling at `anchor` — tie-safe. */
export const keyBeforeIndex = (keys: readonly string[], anchor: number): string =>
  keysBeforeIndex(keys, anchor, 1)[0]
