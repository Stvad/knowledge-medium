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
 * This module answers "what id", never "and then what". Three call shapes sit
 * on top of it, and they differ in the policy they apply to what they find:
 *
 *  - {@link getOrCreateTypedChild} (`@/data/typedRecords`) — a RECORD under a
 *    parent block, inside your tx. Refuses a tombstone (answering `taken`
 *    rather than resurrecting something deleted on purpose), lets you reject an
 *    occupant with `adoptable`, and never overwrites what it adopts.
 *  - {@link getOrCreateKernelPage} (`@/data/kernelPage`) — a per-workspace
 *    singleton PAGE at the root, `repo`-level. Restores a tombstone, because a
 *    kernel page is machinery the app needs present rather than a user record
 *    whose deletion was a decision.
 *  - {@link createOrRestoreTargetBlock} (`@/data/targets`) — the reference-seat
 *    primitive: create-or-restore at an id the CALLER computed, with a
 *    per-domain callback. Alias seats reach it through a probed SEQUENCE of ids
 *    rather than one identity, so they are the one derived-id flow here that
 *    isn't a single `derivedBlockId` call.
 *
 * Reach for one of those before hand-rolling a fourth. If none fits, the thing
 * you are about to write belongs here beside them.
 *
 * Every derived BLOCK id in `src/` resolves through this module. Two `uuidv5`
 * calls outside it are deliberate, and they are deliberate for different
 * reasons:
 *
 *  - `workspaces.ts` derives the local-personal workspace and its member row.
 *    Those aren't blocks, so none of the policy above applies to them.
 *  - `scripts/roam-ts-backfill/build_ts_map.mjs` re-declares `ROAM_IMPORT_NS`,
 *    `DAILY_NOTE_NS` and both key shapes by hand, because it is a standalone
 *    script that must not import the app. It is byte-identical to the
 *    formulas here today, and it is aimed at a few hundred thousand live rows
 *    in a backfill that has not run yet — so re-check it against
 *    `derivedIds.test.ts` before running it, and again if either formula ever
 *    changes. Nothing enforces that copy; a human has to.
 */

import { v5 as uuidv5 } from 'uuid'

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
