/**
 * `Comments (km)`: the one page per workspace that thread roots live under.
 *
 * Created lazily by the first comment. Found by its derived id, so no marker
 * type.
 * Where a thread lives is incidental — discovery is the `annotation:target`
 * edge, so a root moved elsewhere by hand still works.
 */

import type {Block} from '@/data/block'
import type {Repo} from '@/data/repo'
import {getOrCreateKernelPage, kernelPageBlockId} from '@/data/kernelPage'
import type {BlockDeletionGuard} from '@/extensions/core.js'
import {THREAD_TYPE} from './schema.ts'

const COMMENTS_PAGE_NS = 'a2cfb1aa-32fa-4096-8f50-e1aead4127fd'

/** A name nobody types, like `System Migrations (km)`: a plain `Comments` would
 *  leave a user's own page of that name holding the alias, and the container
 *  titled the same beside it. */
export const COMMENTS_PAGE_ALIAS = 'Comments (km)'

export const commentsPageBlockId = (workspaceId: string): string =>
  kernelPageBlockId(workspaceId, COMMENTS_PAGE_NS)

/** A container, so its create is never part of the comment's undo step (see
 *  `getOrCreateKernelPage`): undoing a first comment leaves the page. */
export const getOrCreateCommentsPage = (repo: Repo, workspaceId: string): Promise<Block> =>
  getOrCreateKernelPage(repo, workspaceId, {
    namespace: COMMENTS_PAGE_NS,
    alias: COMMENTS_PAGE_ALIAS,
    markerType: null,
  }, {skipUndo: true})

/** Deleting a page deletes its subtree, so one stray delete of the container
 *  would hide every comment in the workspace, and restoring the page alone
 *  brings none of them back. Undo or a subtree restore is the recovery. Counts
 *  threads anywhere under the page, not only its direct children, since a user
 *  may file them under blocks of their own. */
export const commentsPageDeletionGuard: BlockDeletionGuard = async block => {
  const data = block.peek()
  if (!data || block.id !== commentsPageBlockId(data.workspaceId)) return null
  const threads = await block.repo.query['core.typedBlockCount']({
    workspaceId: data.workspaceId,
    types: [THREAD_TYPE],
    match: [{scope: 'ancestor', id: block.id}],
  }).load()
  if (threads === 0) return null
  return `${COMMENTS_PAGE_ALIAS} holds the workspace’s comment threads and can’t be deleted while it has any. Delete the threads first.`
}
