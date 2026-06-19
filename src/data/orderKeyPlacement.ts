/**
 * Tie-breaking order-key placement (spec §4.1 / A1).
 *
 * `orderKey.ts` is pure key math. These helpers are tx-level because placing a
 * block at a PRECISE visible position can require breaking a tie: two adjacent
 * siblings sharing an `order_key` is a supported on-disk state (the
 * `(parent_id, order_key, id)` index is non-unique; ties arrive via import,
 * `setOrderKey`, and concurrent-sync jitter collisions), and no key sorts
 * strictly between two tied siblings — their order is pinned by the
 * `(order_key, id)` tiebreak. So the only way to open a strict slot between them
 * is to RE-KEY the minimal tied run.
 *
 * "At this position" always means exactly there: `{after: X}` lands immediately
 * after X (between X and its next visible sibling), never past a sibling tied
 * with X. Untied inputs reduce to a plain `keysBetween` with NO extra writes, so
 * the common path is unchanged; re-keys happen only in the rare degenerate tie
 * state, which they also heal as you edit near it.
 *
 * `siblings` is the parent's children in ascending `(order_key, id)` order. When
 * MOVING an existing block, exclude it from `siblings` first (compute the slot
 * against the other siblings) so the move doesn't re-key the block out from
 * under itself.
 */

import type { BlockData, Tx } from '@/data/api'
import { keysBetween } from './orderKey'

/** `n` ascending keys that sort IMMEDIATELY before `siblings[anchor]`. When the
 *  anchor ties with its predecessor (no strict gap), re-key the anchor and its
 *  tied successors up — preserving their order — to open the slot just above the
 *  run key (which the tied predecessors keep). */
export const keysImmediatelyBefore = async (
  tx: Tx,
  parentId: string | null,
  siblings: readonly BlockData[],
  anchor: number,
  n: number,
): Promise<string[]> => {
  const anchorKey = siblings[anchor].orderKey
  const prev = anchor > 0 ? siblings[anchor - 1] : undefined
  if (prev === undefined || prev.orderKey < anchorKey) {
    return keysBetween(prev?.orderKey ?? null, anchorKey, n)
  }
  // anchor ties with its predecessor: re-key anchor..runEnd up into the gap
  // above the run key. `gap = [ ...n new keys, anchor, ...tied successors ]`,
  // ascending, strictly between the run key and the next distinct sibling.
  let runEnd = anchor
  while (runEnd + 1 < siblings.length && siblings[runEnd + 1].orderKey === anchorKey) {
    runEnd++
  }
  const upper = runEnd + 1 < siblings.length ? siblings[runEnd + 1].orderKey : null
  const runLen = runEnd - anchor + 1
  const gap = keysBetween(anchorKey, upper, n + runLen)
  for (let i = anchor; i <= runEnd; i++) {
    await tx.move(siblings[i].id, {parentId, orderKey: gap[n + (i - anchor)]})
  }
  return gap.slice(0, n)
}

/** `n` ascending keys that sort IMMEDIATELY after `siblings[anchor]`. When the
 *  anchor ties with its next sibling, re-key the tied successors up to open the
 *  slot; the anchor keeps its key. */
export const keysImmediatelyAfter = async (
  tx: Tx,
  parentId: string | null,
  siblings: readonly BlockData[],
  anchor: number,
  n: number,
): Promise<string[]> => {
  const anchorKey = siblings[anchor].orderKey
  const next = anchor + 1 < siblings.length ? siblings[anchor + 1] : undefined
  if (next === undefined || anchorKey < next.orderKey) {
    return keysBetween(anchorKey, next?.orderKey ?? null, n)
  }
  // anchor ties with its next sibling: re-key anchor+1..runEnd up. `gap =
  // [ ...n new keys, ...tied successors ]`, ascending, strictly between the
  // anchor's key (which it keeps) and the next distinct sibling.
  let runEnd = anchor + 1
  while (runEnd + 1 < siblings.length && siblings[runEnd + 1].orderKey === anchorKey) {
    runEnd++
  }
  const upper = runEnd + 1 < siblings.length ? siblings[runEnd + 1].orderKey : null
  const successors = runEnd - anchor
  const gap = keysBetween(anchorKey, upper, n + successors)
  for (let i = anchor + 1; i <= runEnd; i++) {
    await tx.move(siblings[i].id, {parentId, orderKey: gap[n + (i - anchor - 1)]})
  }
  return gap.slice(0, n)
}

/** Single-key convenience wrapper for {@link keysImmediatelyBefore}. */
export const keyImmediatelyBefore = async (
  tx: Tx,
  parentId: string | null,
  siblings: readonly BlockData[],
  anchor: number,
): Promise<string> => (await keysImmediatelyBefore(tx, parentId, siblings, anchor, 1))[0]

/** Single-key convenience wrapper for {@link keysImmediatelyAfter}. */
export const keyImmediatelyAfter = async (
  tx: Tx,
  parentId: string | null,
  siblings: readonly BlockData[],
  anchor: number,
): Promise<string> => (await keysImmediatelyAfter(tx, parentId, siblings, anchor, 1))[0]
