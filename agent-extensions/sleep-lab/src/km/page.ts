/** Per-workspace bootstrap: the Sleep Lab page.
 *
 *  A kernel page — a deterministic per-workspace singleton with a human
 *  alias — so nights and experiments have a stable home and the same row
 *  converges across offline clients.
 */

import type {Block} from '@/data/block.js'
import {getOrCreateKernelPage, kernelPageBlockId} from '@/data/kernelPage.js'
import type {Repo} from '@/data/repo.js'

import {LAB_TYPE} from './fields'

// A fresh, randomly-generated uuid-v5 namespace for this page kind. Never
// change it: every page already written under it would be orphaned.
const LAB_NS = 'f86172b9-95c3-4e6e-9e64-0f5d53eb75c2'
export const LAB_ALIAS = 'Sleep Lab'

/** The page if it already exists, WITHOUT creating it. Reading must not
 *  bootstrap: a dashboard you merely navigated past is not a reason to
 *  write a synced page. */
export const findLabPage = async (repo: Repo, workspaceId: string): Promise<string | null> => {
  const id = kernelPageBlockId(workspaceId, LAB_NS)
  const block = await repo.load(id)
  return block && !block.deleted ? id : null
}

export const getOrCreateLabPage = (repo: Repo, workspaceId: string): Promise<Block> =>
  getOrCreateKernelPage(repo, workspaceId, {
    namespace: LAB_NS,
    alias: LAB_ALIAS,
    markerType: LAB_TYPE,
  })
