import type { Block } from '@/data/block'
import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import { ChangeScope, seedType, seedProperty, type PropertySeedDeclaration } from '@/data/api'
import { getPluginUIStateBlock } from '@/data/stateBlocks.js'
import { hasOpaqueContent } from '@/data/properties'
import { labelForBlockData, readTypeIds } from '@/utils/linkTargetAutocomplete.js'

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

export const quickFindUIStateType = seedType({
  seedKey: 'system:quick-find/type/quick-find-ui-state',
  revision: 1,
  id: 'quick-find-ui-state',
  label: 'Quick find',
  properties: [recentBlockIdsProp],
})

export const pushRecentBlockId = (uiStateBlock: Block, blockId: string): void => {
  const current = uiStateBlock.peekProperty(recentBlockIdsProp) ?? []
  const next = [blockId, ...current.filter(id => id !== blockId)].slice(0, RECENT_BLOCKS_LIMIT)
  void uiStateBlock.set(recentBlockIdsProp, next)
}

export interface RecentItem {
  blockId: string
  label: string
  /** Needed to tell a top-level block from one whose parent is gone when
   *  the ancestor walk comes back empty — see `crumbsFromAncestors`. */
  parentId: string | null
  typeIds: readonly string[]
}

/** One "Recent" row's display shape, from the block it points at.
 *
 *  Pure, and separate from the loading effect that calls it, so what a
 *  row actually derives is testable without mounting the dialog.
 *
 *  Shares `labelForBlockData` with the search rows rather than reaching
 *  for `aliases[0]`: that helper skips blank and non-string entries, so
 *  a block whose first alias is `''` (reachable through a raw
 *  properties-bag write) falls through to its content instead of
 *  rendering a Recent row with no visible label. `parentId` and the
 *  types both ride along on `BlockData` already — neither costs a
 *  query. */
export const recentItemFromBlockData = (
  blockId: string,
  data: BlockData,
  opaqueContentTypes: ReadonlySet<string>,
): RecentItem => ({
  blockId,
  // The MRU is the one list that never goes through the search merge point,
  // so its opaque rows arrive unfiltered. They KEEP their entry — you were
  // just editing that extension and want to get back to it — but their
  // content is not a label: fall through to the alias, then the id, never
  // the bytes.
  label: hasOpaqueContent(data, opaqueContentTypes)
    ? labelForBlockData({...data, content: ''}, blockId)
    : labelForBlockData(data, blockId),
  parentId: data.parentId,
  typeIds: readTypeIds(data),
})

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
