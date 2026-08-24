import type { Repo } from '@/data/repo.js'
import { MergeIntoDescendantError } from '@/data/api'
import { showError } from '@/utils/toast.js'
import { ensureDeletableThroughUi } from '@/utils/deleteBlockThroughUi.js'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks.js'
import { retargetPanelBlockIds } from '@/utils/panelLayoutProjection.js'
import { truncate } from '@/utils/string.js'
import { ALIAS_COLLISION_MERGE_MUTATOR, AliasMergeBlockedError } from './collisionMerge.ts'

/**
 * Fold every rival claimant of `alias` into `intoId` — the duplicate-name
 * banner's direction (`sourceIsAliasOwner: true`): each rival still HOLDS
 * the alias, and `intoId` is reclaiming it, so a rival's title survives as
 * an alias rather than being dropped.
 *
 * Merge direction is canonical-wins: identity stays at `intoId` — the
 * deterministic id — and the name comes back there along with each rival's
 * children, properties and inbound references.
 *
 * Resolves `true` once the merge has committed, `false` if it was refused
 * (the deletion guards) or failed (a caught error, toasted). A panel
 * retarget failure after a successful merge does NOT flip this to `false` —
 * the merge already committed, so the caller has nothing left to undo.
 */
export const mergeAliasCollision = async (
  repo: Repo,
  opts: {intoId: string; rivalIds: readonly string[]; alias: string; workspaceId: string},
): Promise<boolean> => {
  const {intoId, rivalIds, alias, workspaceId} = opts
  try {
    // Merging soft-deletes the other page, so it goes through the same UI
    // deletion refusal an explicit delete would — the merge picker does this
    // too. Without it a one-click merge silently deletes a page the app
    // otherwise refuses to let you delete.
    if (!await ensureDeletableThroughUi(rivalIds.map(id => repo.block(id)))) return false

    await repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
      intoId,
      fromIds: [...rivalIds],
      collisionAlias: alias,
      sourceIsAliasOwner: true,
    })

    // Any panel showing an absorbed page now points at a tombstone; move
    // them to the survivor, as the rejection toast does after the same call.
    const uiState = await getUIStateBlock(repo, workspaceId, repo.user, {})
    const layoutSessionBlock = await getLayoutSessionBlock(uiState, repo.activeLayoutSessionId)
    try {
      for (const rivalId of rivalIds) {
        await retargetPanelBlockIds(repo, layoutSessionBlock, rivalId, intoId)
      }
    } catch (error) {
      console.error('[mergeAliasCollision] Failed to retarget panels after merge', error)
      showError('Merged, but panel update failed')
    }
    return true
  } catch (error) {
    // Two refusals worth explaining, because the raw error says nothing
    // useful and both are things the user can act on.
    if (error instanceof MergeIntoDescendantError) {
      // Direction matters in the copy: this means THIS page sits inside the
      // other one, so the user has to move this page out — the reverse of
      // what a naive reading suggests.
      showError(`This page is inside “${truncate(alias, 40)}” — move it out before merging.`)
      return false
    }
    if (error instanceof AliasMergeBlockedError) {
      showError(
        `Can’t merge: “${truncate(error.alias, 40)}” is also used by a page this wouldn’t absorb. `
        + 'Resolve that name first.',
      )
      return false
    }
    showError(`Couldn’t merge “${truncate(alias, 40)}”.`)
    return false
  }
}
