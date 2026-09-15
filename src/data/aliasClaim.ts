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
  const claimant = await tx.aliasLookup(alias, workspaceId)
  if (claimant === null || claimant.id === blockId) return
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
