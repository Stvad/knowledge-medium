/**
 * Commenting works as replying does: the thread and an empty first comment
 * are written at once, and the comment opens in the block editor in the
 * thread's card, where it is an ordinary block. A thread the user leaves with
 * nothing written in it goes again. A tab closed mid-comment leaves the empty
 * thread, as an abandoned reply leaves its empty comment; so does a card that
 * never mounts its editor (a target the margin doesn't show, the margin hidden
 * mid-comment), which is accepted.
 *
 * An edit suggestion is composed before it is written (`Composer`): its
 * replacement only becomes a valid suggestion once edited.
 */

import {ChangeScope, type BlockData, type Tx} from '@/data/api'
import type {Block} from '@/data/block'
import {isEditingProp, peekFocusedBlockLocation} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {visibleChildrenOf} from '@/data/visibleChildren'
import {blockEditSettled} from '@/editor/editSettleSignal.js'
import {enterEditModeForBlock} from '@/extensions/blockInteraction.js'
import {deleteBlockThroughUi} from '@/utils/deleteBlockThroughUi.js'
import {panelIdOfRenderScopeId} from '@/utils/renderScope'
import {showError, showInfo} from '@/utils/toast.js'
import type {RangeAnchor} from './anchor.ts'
import {confirmThreadDeletion} from './confirmThreadDeletion.tsx'
import {createThread, isThreadRefusal} from './threads.ts'
import {cardRenderScopeId, outerCardSurface, revealThread, viewKey} from './uiStore.ts'

export const NOT_ON_OUTLINE = 'Open the block in its page to comment on it.'

export interface StartCommentArgs {
  targetId: string
  /** null comments on the whole block. */
  anchor: RangeAnchor | null
  /** The scope the target was commented on in: a panel's outline. */
  renderScopeId: string | undefined
}

/** Write the thread and open its empty first comment for editing, in the
 *  card that shows it: the margin's where it is drawn, else inline. False
 *  when nothing was written, with the reason shown. */
export const startComment = async (
  repo: Repo,
  {targetId, anchor, renderScopeId}: StartCommentArgs,
): Promise<boolean> => {
  const panelId = renderScopeId === undefined ? undefined : panelIdOfRenderScopeId(renderScopeId)
  if (!renderScopeId || !panelId) {
    showInfo(NOT_ON_OUTLINE)
    return false
  }
  let created
  try {
    created = await createThread(repo, {targetId, anchor, emptyComment: true})
  } catch (error) {
    if (!isThreadRefusal(error)) throw error
    showError(error.message)
    return false
  }
  const {threadId} = created
  const panel = repo.block(panelId)
  const scope = cardRenderScopeId(outerCardSurface(panelId), renderScopeId, threadId)
  revealThread(panelId, viewKey(renderScopeId, targetId), threadId, true)
  await enterEditModeForBlock(repo.block(created.commentId!), panel, scope, {start: 0})
  dropWhenLeftEmpty(repo.block(threadId), panel, scope)
  return true
}

/** Is a comment of the card being edited? Not the root, which shows no
 *  editor: Backspace in an empty first comment deletes it and focuses the
 *  root. */
const writingIn = (panel: Block, threadId: string, scope: string): boolean => {
  const location = peekFocusedBlockLocation(panel)
  return location?.renderScopeId === scope && location.blockId !== threadId &&
    Boolean(panel.peekProperty(isEditingProp))
}

/** Once, the first time an editor goes away while no comment of the card is
 *  being edited: Escape, a click elsewhere, a navigation. Whichever comment
 *  it was, so a sibling made by Enter, or a comment deleted by Backspace,
 *  counts the same. */
const dropWhenLeftEmpty = (thread: Block, panel: Block, scope: string): void => {
  const stop = blockEditSettled.add(() => {
    if (writingIn(panel, thread.id, scope)) return
    stop()
    dropIfEmpty(thread).catch(error => showError(error instanceof Error ? error.message : String(error)))
  })
}

/** A comment with nothing in it: no text, no properties, no child of any
 *  kind (a property row is one). */
const isBlankComment = async (tx: Tx, comment: BlockData): Promise<boolean> =>
  comment.content.trim() === '' && Object.keys(comment.properties).length === 0 &&
  (await tx.childrenOf(comment.id)).length === 0

/** Read in a transaction, so it sees the text an editor flushed as it
 *  unmounted, which is queued ahead of it. The root's own property rows are
 *  not comments, so the comments are its visible children. */
const dropIfEmpty = async (thread: Block): Promise<void> => {
  const empty = await thread.repo.tx(async tx => {
    const root = await tx.get(thread.id)
    if (!root || root.deleted) return false
    for (const comment of await visibleChildrenOf(tx, thread.id)) {
      if (!await isBlankComment(tx, comment)) return false
    }
    return true
  }, {scope: ChangeScope.BlockDefault, description: 'check new comment'})
  if (empty && await confirmThreadDeletion(thread)) await deleteBlockThroughUi(thread)
}
