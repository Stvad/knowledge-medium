import {ChangeScope} from '@/data/api'
import type {Block} from '@/data/block'
import {visibleChildrenOf} from '@/data/visibleChildren'
import {deleteBlockThroughUi} from '@/utils/deleteBlockThroughUi.js'
import {confirmThreadDeletion} from './confirmThreadDeletion.tsx'
import {THREAD_TYPE} from './schema.ts'

export const DELETED_COMMENT_CONTENT = '[deleted]'

export type CommentDeletion = 'blanked' | 'deleted' | 'deleted-thread' | 'refused'

/** Delete a comment from its card.
 *
 * A comment with replies is blanked to "[deleted]" instead, because deleting a
 * block deletes its children and those replies may be someone else's. The last
 * comment of a thread takes the thread with it, after asking if the thread is
 * quoted (`confirmThreadDeletion`). Both are rules of the card
 * only: deleting in the outline still removes the subtree, and undo restores
 * it. The reply check runs inside the blanking tx; a reply that syncs in after
 * it and before the UI delete goes with the delete, which undo restores. */
export const deleteCommentFromCard = (comment: Block): Promise<CommentDeletion> => deleteFromCard(comment, false)

/** After the user confirms deleting a quoted thread, everything is decided
 *  again: a reply or comment that synced in while the dialog was open changes
 *  what the delete may take. */
const deleteFromCard = async (comment: Block, confirmed: boolean): Promise<CommentDeletion> => {
  const repo = comment.repo
  const blanked = await repo.tx(async tx => {
    if ((await visibleChildrenOf(tx, comment.id)).length === 0) return false
    await tx.update(comment.id, {content: DELETED_COMMENT_CONTENT})
    return true
  }, {scope: ChangeScope.BlockDefault, description: 'delete comment'})
  if (blanked) return 'blanked'

  await comment.load()
  const parent = comment.parent
  if (parent && await parent.load() && parent.hasType(THREAD_TYPE)) {
    if ((await parent.children.load()).length === 1) {
      if (!confirmed) return await confirmThreadDeletion(parent) ? deleteFromCard(comment, true) : 'refused'
      return await deleteBlockThroughUi(parent) ? 'deleted-thread' : 'refused'
    }
  }
  return await deleteBlockThroughUi(comment) ? 'deleted' : 'refused'
}
