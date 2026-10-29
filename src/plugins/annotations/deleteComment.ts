import {ChangeScope} from '@/data/api'
import type {Block} from '@/data/block'
import {hasBlockType} from '@/data/properties'
import {visibleChildrenOf} from '@/data/visibleChildren'
import {deleteBlockThroughUi} from '@/utils/deleteBlockThroughUi.js'
import {THREAD_TYPE} from './schema.ts'

export const DELETED_COMMENT_CONTENT = '[deleted]'

export type CommentDeletion = 'blanked' | 'deleted' | 'deleted-thread' | 'refused'

/** Delete a comment from its card.
 *
 * A comment with replies is blanked to "[deleted]" instead, because deleting a
 * block deletes its children and those replies may be someone else's. The last
 * comment of a thread takes the thread with it. Both are rules of the card
 * only: deleting in the outline still removes the subtree, and undo restores
 * it. The reply check reruns inside the blanking tx; a reply that syncs in
 * between it and a UI delete goes with the delete, which undo restores. */
export const deleteCommentFromCard = async (comment: Block): Promise<CommentDeletion> => {
  const repo = comment.repo
  const blanked = await repo.tx(async tx => {
    if ((await visibleChildrenOf(tx, comment.id)).length === 0) return false
    await tx.update(comment.id, {content: DELETED_COMMENT_CONTENT})
    return true
  }, {scope: ChangeScope.BlockDefault, description: 'delete comment'})
  if (blanked) return 'blanked'

  const data = await comment.load()
  const parent = data?.parentId ? repo.block(data.parentId) : null
  const parentData = await parent?.load()
  if (parent && parentData && hasBlockType(parentData, THREAD_TYPE)) {
    if ((await parent.children.load()).length === 1) {
      return await deleteBlockThroughUi(parent) ? 'deleted-thread' : 'refused'
    }
  }
  return await deleteBlockThroughUi(comment) ? 'deleted' : 'refused'
}
