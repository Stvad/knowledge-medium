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

/** `skipUndo`: there is no user operation for this create to merge into on
 *  either path. Workspace bootstrap runs it unattended, and opening Recents is
 *  a navigation — cmd-Z after clicking the clock should undo whatever the user
 *  last edited, not un-create the page they are looking at. A lone entry is
 *  worse than useless here: `UndoManager.record` clears the redo branch on every
 *  push, so an unattended create silently discards a redo the user still wanted.
 *  (Bootstrap alone would not have needed this — the stack is empty that early —
 *  but the lazy get-or-create at the point of use runs against a live stack.) */
export const getOrCreateRecentsPage = (repo: Repo, workspaceId: string): Promise<Block> =>
  getOrCreateKernelPage(repo, workspaceId, {
    namespace: RECENTS_PAGE_NS,
    alias: RECENTS_ALIAS,
    markerType: RECENTS_PAGE_TYPE,
  }, {skipUndo: true})
