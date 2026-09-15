/**
 * Refusing a claim on a name another live block already holds.
 *
 * The storage trigger is the final authority — it fires on any write that
 * reaches the alias index, and `Repo` translates its RAISE into this same
 * `alias.collision` code. A preflight exists for one reason: a rejection built
 * after the rollback cannot say which entries a merge would have to drop, and
 * the toast's "Merge into…" offer is built from exactly that. So whoever is
 * about to claim a name asks FIRST, and the trigger stays the backstop for
 * every other write path.
 *
 * In core because two writers need it — the kernel's type naming and the alias
 * plugin's rename sync — and the one that must not depend on the other is the
 * kernel's.
 */

import { ProcessorRejection, type Tx } from '@/data/api'

export interface AliasClaimIntent {
  alias: string
  /** The claimant. Already holding the name is not a collision. */
  blockId: string
  workspaceId: string
  /** Entries the "Merge into…" action should drop from this block when the
   *  user accepts the merge — the names it is giving up by claiming. */
  dropSourceAliases?: readonly string[]
  /** What the user did, for the toast's wording and affordances. */
  collisionOrigin?: string
}

export const assertAliasClaimable = async (
  tx: Tx,
  {alias, blockId, workspaceId, dropSourceAliases = [], collisionOrigin}: AliasClaimIntent,
): Promise<void> => {
  // EVERY claimant, not `aliasLookup`'s oldest one: the single-row form answers
  // "who is named X", which is this block itself whenever it is the older of
  // two co-claimants (reachable — the uniqueness trigger skips sync-apply).
  //
  // Defence in depth, deliberately: no caller can reach a case the two readers
  // answer differently. They differ only when the claimant IS this block, and
  // then this block already holds the name — so its own write re-inserts the
  // whole bag through the maintenance trigger and the uniqueness check runs
  // there instead. The contract on `aliasClaimants` is still the right reader
  // for a veto, and costs nothing here.
  const claimants = await tx.aliasClaimants(alias, workspaceId)
  const claimant = claimants.find(block => block.id !== blockId)
  if (claimant === undefined) return
  throw new ProcessorRejection(
    `Alias "${alias}" is already used by another block`,
    'alias.collision',
    {
      alias,
      conflictingBlockId: claimant.id,
      // 80 chars: the toast doesn't render long strings well.
      conflictingBlockTitle: claimant.content.slice(0, 80),
      workspaceId,
      attemptedOn: blockId,
      dropSourceAliases: [...dropSourceAliases],
      ...(collisionOrigin === undefined ? {} : {collisionOrigin}),
    },
  )
}
