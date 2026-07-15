import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { ChangeScope, defineBlockType, seedProperty, type PropertySeedDeclaration } from '@/data/api'
import { getPluginUIStateBlock } from '@/data/stateBlocks.js'

export const RECENT_BLOCKS_LIMIT = 10

/** Recently-opened block-id MRU list. Per-device state — what *this*
 *  device's user has just been looking at. Lives on the plugin's
 *  ui-state sub-block (see `quickFindUIStateType`), scoped to UiState
 *  so it stays in its own undo bucket. The sub-block has a deterministic
 *  id derived from (workspace, user), so if it does sync the per-device
 *  semantic still holds — each device's quick-find subtree is keyed
 *  to that device's user identity. */
export const recentBlockIdsProp = seedProperty({
  seedKey: 'system:quick-find/property/recent-block-ids',
  revision: 1,
  name: 'recentBlockIds',
  preset: 'string-list',
  defaultValue: [],
  changeScope: ChangeScope.UiState,
// The shared string-list core returns a fresh mutable array, but exposes it as
// readonly. Preserve this handle's historical string[] contract locally.
}) as PropertySeedDeclaration<string[]>

export const quickFindUIStateType = defineBlockType({
  id: 'quick-find-ui-state',
  label: 'Quick find',
  properties: [recentBlockIdsProp],
})

export const pushRecentBlockId = (uiStateBlock: Block, blockId: string): void => {
  const current = uiStateBlock.peekProperty(recentBlockIdsProp) ?? []
  const next = [blockId, ...current.filter(id => id !== blockId)].slice(0, RECENT_BLOCKS_LIMIT)
  void uiStateBlock.set(recentBlockIdsProp, next)
}

/** Read the MRU from anywhere with a `Repo` — autocomplete sources
 *  (editor extensions, link-target searches) live outside the QuickFind
 *  React tree but need the same recency signal to rank candidates. The
 *  ui-state sub-block is resolved through the same memoized helper
 *  QuickFind itself uses, so subsequent reads are O(1). Returns `[]` if
 *  the sub-block hasn't been initialized yet (first-run before any
 *  navigation). */
export const loadRecentBlockIds = async (
  repo: Repo,
  workspaceId: string,
): Promise<string[]> => {
  if (!workspaceId) return []
  try {
    const block = await getPluginUIStateBlock(repo, workspaceId, repo.user, quickFindUIStateType)
    return block.peekProperty(recentBlockIdsProp) ?? []
  } catch {
    return []
  }
}
