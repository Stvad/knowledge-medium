/** Recents-page bootstrap. Thin wrapper around `getOrCreateKernelPage`
 *  with Recents-specific args. Each workspace has one Recents page;
 *  the recents plugin renders a list of recently-edited blocks on it
 *  via the `recentBlocks` kernel query. */

import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { RECENTS_PAGE_TYPE } from '@/data/blockTypes'
import { getOrCreateKernelPage, kernelPageBlockId } from './kernelPage'

const RECENTS_PAGE_NS = '4f2c8d61-1a35-4a90-8b6f-2a3a0c8d9b41'
const RECENTS_ALIAS = 'Recents'

export const recentsPageBlockId = (workspaceId: string): string =>
  kernelPageBlockId(workspaceId, RECENTS_PAGE_NS)

export const getOrCreateRecentsPage = (repo: Repo, workspaceId: string): Promise<Block> =>
  getOrCreateKernelPage(repo, workspaceId, {
    namespace: RECENTS_PAGE_NS,
    alias: RECENTS_ALIAS,
    markerType: RECENTS_PAGE_TYPE,
  })
