/**
 * One block id, derived from what the block IS.
 *
 * A derived id is how two writers who never met agree on a row. Both compute
 * the id from the same facts, so both write to the same block — one record
 * instead of a duplicate nobody can reach. That is worth reaching for whenever
 * something OTHER than the caller controls when a write fires: a UI gesture, a
 * sync callback, a bootstrap that runs on every launch, a second device.
 *
 * The alternative shape — "query for it, then create if absent" — cannot be
 * made correct. The query answers for the moment it ran; two clients (or one
 * client twice) both read absent and both create.
 *
 * ## What convergence is, and is not
 *
 * It is row-level: you get one block instead of two. It is NOT a merge. The
 * losing insert is skipped whole (`apply_block_creates` is insert-or-touch),
 * and later edits settle column-wise last-write-wins. Values only one writer
 * ever wrote, and which nothing re-asserts afterwards, are lost with the race.
 *
 * ## Choosing a key
 *
 * The key is the WHOLE identity. A parent scopes a record only if the parent's
 * own id is IN the key. Include the workspace id unless something already in
 * the key implies it — two workspaces that derive the same id collide, and one
 * of them finds its block occupied by the other's.
 *
 * If any part of the key is user-supplied text, escape the separator: `"a|b"`
 * with occurrence `0` and `"a"` with occurrence `1` must not spell one key.
 *
 * Pick the namespace once per block KIND (`crypto.randomUUID()` in a console)
 * and hard-code it. Changing a namespace, or the shape of a key, re-points the
 * kind at fresh ids and orphans every row already written under the old one —
 * so the formulas below are pinned by `derivedIds.test.ts`, which compares each
 * one against its literal historical expression.
 *
 * ## Which get-or-create do I want?
 *
 * This module answers what the id IS, and whether what is sitting at it is
 * YOURS ({@link classifyOccupant}) — never what to do about it.
 *
 *  - {@link getOrCreateTypedChild} (`@/data/typedRecords`) — refuses a tombstone.
 *  - {@link getOrCreateKernelPage} (`@/data/kernelPage`) — restores a tombstone.
 *  - {@link createOrRestoreTargetBlock} (`@/data/targets`) — probes a SEQUENCE
 *    of ids rather than one identity.
 *
 * Reach for one of those before hand-rolling a fourth.
 *
 * `scripts/roam-ts-backfill/build_ts_map.mjs` re-declares `ROAM_IMPORT_NS`,
 * `DAILY_NOTE_NS` and both key shapes by hand because it must not import the
 * app; nothing enforces the copy — re-check it against `derivedIds.test.ts`
 * before running it and whenever a formula changes.
 */

import { v5 as uuidv5 } from 'uuid'
import type { BlockData } from './api'
import { USER_STATE_ROOT_PATHS } from './userPrefs'

/**
 * What makes a block THIS one and not another.
 *
 * `namespace` is a uuid-v5 namespace, one per block kind. `key` is the natural
 * identity — everything that distinguishes this block from its siblings in the
 * kind (`"<workspaceId>|2026-07-24|A"`).
 */
export interface DerivedIdentity {
  namespace: string
  key: string
}

/** The one block id a {@link DerivedIdentity} resolves to.
 *
 *  A pure function of the identity and nothing else — which is the whole
 *  point: every device computes the same id from the same facts, with no
 *  reference to what that device happens to hold. */
export const derivedBlockId = (identity: DerivedIdentity): string =>
  uuidv5(identity.key, identity.namespace)

// Per-(parent, content) state child — user-prefs, ui-state, panels,
// per-plugin state, and everything else `ensureStateChild` materializes,
// so each name resolves to the same block id across clients. Lives here
// rather than in `stateBlocks.ts` (which owns the writes) so a caller
// that only needs the ID — the Recents filter walking down from the
// state roots — can derive it without importing the write path.
const STATE_CHILD_NS = '8f6c2c84-1c12-4e4a-8b9e-9b0f87a7e1d2'

/** Deterministic id of a named state child under `parentId`. Every user
 *  preference, ui-state row, panel and per-plugin prefs block hangs off
 *  one of these, so a change to the key or the namespace orphans all of
 *  them at once (pinned in `derivedIds.test.ts`). */
export const stateChildBlockId = (parentId: string, content: string): string =>
  derivedBlockId({namespace: STATE_CHILD_NS, key: `${parentId}:${content}`})

/** The state roots under one user page — what a reader must walk down
 *  from to recognize app-owned state, and the reason the list of paths
 *  is declared next to nothing else. */
export const userStateRootBlockIds = (userPageId: string): string[] =>
  USER_STATE_ROOT_PATHS.map(path => stateChildBlockId(userPageId, path))

/**
 * What is sitting at a derived id, as one caller sees it.
 *
 * A derived id tells you WHERE to look; it never promises the row you find is
 * the one you meant. Every get-or-create above therefore reads the id and then
 * asks the same question — "is this mine to write through?"
 *
 * So the CLASSIFICATION lives here, once, and each caller applies its own
 * POLICY to the verdict. A kernel page restores a `tombstoned`; a record
 * refuses one. They are allowed to disagree about that — what they may not do
 * is disagree about what `tombstoned` MEANS, or forget to ask about `foreign`.
 *
 * `createOrRestoreTargetBlock` is deliberately NOT routed through here: it
 * delegates to `tx.createOrGet`, which classifies inside the engine and raises
 * `DeletedConflictError` / `DeterministicIdCrossWorkspaceError` for the caller
 * to catch. That is the same taxonomy reached from the other side, and it needs
 * no read of its own — so routing it through this predicate would add a read,
 * not consistency.
 */
export type OccupantVerdict =
  /** No row at this id at all. Yours to create. */
  | 'absent'
  /** A row belonging to a DIFFERENT workspace.
   *
   *  Never yours, whatever the key says. Reachable two ways: a namespace whose
   *  key omits the workspace (or is chosen by extension code, which the app
   *  does not control), and — for any id at all — the window between a read and
   *  the transaction that acts on it, because sync materialization rewrites
   *  every stored column except `id`, `workspace_id` included. */
  | 'foreign'
  /** A soft-deleted row in this workspace. Whether that is an obstacle or
   *  something to restore is the caller's policy; that it is not a live record
   *  is not. */
  | 'tombstoned'
  /** Live and in this workspace, but the caller's own `adoptable` declined it
   *  — the record moved, finished, or otherwise stopped being the one this
   *  identity meant. */
  | 'rejected'
  /** Live, this workspace, accepted. The ONLY verdict you may write through. */
  | 'ours'

/** A verdict paired with the row it describes, so callers narrow instead of
 *  casting. `block` is non-null for every verdict but `absent`. */
export type Occupancy =
  | { verdict: 'absent'; block: null }
  | { verdict: Exclude<OccupantVerdict, 'absent'>; block: BlockData }

export interface OccupantPolicy {
  /** The workspace the caller is acting in — for a record, its PARENT's
   *  workspace, not one the caller carries separately. */
  workspaceId: string
  /** May this block serve as the thing at this identity? Consulted only for a
   *  live row in `workspaceId`, so it never has to re-check either. */
  adoptable?: (block: BlockData) => boolean
}

/**
 * Classify the row at a derived id. Pure; the caller does the reading.
 *
 * The order of the clauses is part of the contract, not an implementation
 * detail:
 *
 *  - `foreign` outranks `tombstoned`, so a tombstone in someone else's
 *    workspace reports `foreign`. That is what keeps a restore policy — which
 *    keys on `tombstoned` — structurally unable to resurrect another
 *    workspace's row: it never sees that verdict, rather than having to
 *    remember a second check beside it.
 *  - `adoptable` runs last, so it is never asked about a tombstone or a
 *    foreign row. A predicate written against live records ("is this workout
 *    still open?") would happily say yes to both.
 */
export const classifyOccupant = (
  occupant: BlockData | null,
  policy: OccupantPolicy,
): Occupancy => {
  if (occupant === null) return {verdict: 'absent', block: null}
  if (occupant.workspaceId !== policy.workspaceId) return {verdict: 'foreign', block: occupant}
  if (occupant.deleted) return {verdict: 'tombstoned', block: occupant}
  if (policy.adoptable && !policy.adoptable(occupant)) return {verdict: 'rejected', block: occupant}
  return {verdict: 'ours', block: occupant}
}
