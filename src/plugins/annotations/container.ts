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
import {getOrCreateKernelPage, kernelPageBlockId, type KernelPageSpec} from '@/data/kernelPage'

const COMMENTS_PAGE_NS = 'a2cfb1aa-32fa-4096-8f50-e1aead4127fd'

/** A name nobody types, like `System Migrations (km)`: a plain `Comments` would
 *  leave a user's own page of that name holding the alias, and the container
 *  titled the same beside it. */
export const COMMENTS_PAGE_ALIAS = 'Comments (km)'

export const commentsPageSpec: KernelPageSpec = {
  namespace: COMMENTS_PAGE_NS,
  alias: COMMENTS_PAGE_ALIAS,
  markerType: null,
}

export const commentsPageBlockId = (workspaceId: string): string =>
  kernelPageBlockId(workspaceId, COMMENTS_PAGE_NS)

/** A container, so its create is never part of the comment's undo step (see
 *  `getOrCreateKernelPage`): undoing a first comment leaves the page. */
export const getOrCreateCommentsPage = (repo: Repo, workspaceId: string): Promise<Block> =>
  getOrCreateKernelPage(repo, workspaceId, commentsPageSpec, {skipUndo: true})
