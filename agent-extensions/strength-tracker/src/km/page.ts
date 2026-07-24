/** Per-workspace bootstrap: the Strength Log page and its settings block.
 *
 *  The page is a kernel page — a deterministic per-workspace singleton with
 *  a human alias — so workouts and layoffs have a stable home and the same
 *  row converges across offline clients. The settings block is a lazily
 *  created child holding the engine knobs; the program content itself is
 *  read from the plan outline, not stored here.
 */

import {ChangeScope} from '@/data/api/index.js'
import type {Block} from '@/data/block.js'
import {getOrCreateKernelPage} from '@/data/kernelPage.js'
import {createChild} from '@/data/mutators.js'
import {hasBlockType} from '@/data/properties.js'
import type {Repo} from '@/data/repo.js'

import {SETTINGS_TYPE, STRENGTH_LOG_TYPE} from './schema'

// A fresh, randomly-generated uuid-v5 namespace for this page kind, so its
// deterministic id can never collide with another kernel page.
const STRENGTH_LOG_NS = 'b7e1d4c2-9a63-4f80-8c15-3e6d5a2f9b04'
const STRENGTH_LOG_ALIAS = 'Strength Log'

export const getOrCreateStrengthLogPage = (repo: Repo, workspaceId: string): Promise<Block> =>
  getOrCreateKernelPage(repo, workspaceId, {
    namespace: STRENGTH_LOG_NS,
    alias: STRENGTH_LOG_ALIAS,
    markerType: STRENGTH_LOG_TYPE,
  })

/** Get or create the settings child under the page. Re-checks inside the tx
 *  so two eager bootstraps can't both create one. */
export const getOrCreateSettingsBlock = async (
  repo: Repo,
  workspaceId: string,
  pageId: string,
): Promise<string> => {
  const existing = await repo.queryBlocks({workspaceId, types: [SETTINGS_TYPE]})
  const here = existing.find(b => b.parentId === pageId)
  if (here) return here.id

  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
    const siblings = await tx.childrenOf(pageId)
    const already = siblings.find(b => hasBlockType(b, SETTINGS_TYPE))
    if (already) return already.id
    const id = await tx.run(createChild, {parentId: pageId, content: 'Strength settings', position: {kind: 'last'}})
    await repo.addTypeInTx(tx, id, SETTINGS_TYPE, {}, typeSnapshot)
    return id
    // Structural block creation is BlockDefault; the individual setting
    // *values* carry their own UserPrefs scope when the user edits them.
  }, {scope: ChangeScope.BlockDefault, description: 'Create strength settings'})
}
