/**
 * Moving a comment to a thread of its own: pick the block the new thread is
 * on, the blocks the comment links on its thread's page offered first
 * (`ownThreadTargets`), then write it (`moveToOwnThread`) and show the comment
 * in its new card (`goToComment`).
 */

import type {Block} from '@/data/block'
import type {Repo} from '@/data/repo'
import {BlockSearchPicker} from '@/components/BlockSearchPicker.tsx'
import {openDialog, type DialogContextProps} from '@/utils/dialogs.js'
import {firstLine} from '@/utils/string.js'
import {goToComment} from './commentLinks.ts'
import {moveToOwnThread, ownThreadTargets} from './threads.ts'

interface OwnThreadPickerProps {
  workspaceId: string
  suggested: {blockId: string; content: string}[]
  /** The comment and its replies: a thread on any of them is refused. */
  exclude: string[]
}

const OwnThreadPicker = ({workspaceId, suggested, exclude, resolve, cancel}: DialogContextProps<string> & OwnThreadPickerProps) =>
  <BlockSearchPicker
    title="Move to its own thread"
    description="The comment and its replies become a new thread on the block you pick."
    placeholder="Find the block it is about…"
    workspaceId={workspaceId}
    excludeBlockIds={exclude}
    suggestions={{heading: 'Linked in this comment', blocks: suggested}}
    onSelect={resolve}
    onCancel={cancel}
  />

const excerptOf = async (repo: Repo, id: string): Promise<string> => firstLine((await repo.load(id))?.content ?? '')

/** Ask where, move, and show the comment in its new card from `panelId`. */
export const moveCommentToOwnThread = async (comment: Block, panelId: string | undefined): Promise<void> => {
  const repo = comment.repo
  const [targets, subtree] = await Promise.all([
    ownThreadTargets(repo, comment.id),
    repo.query.subtree({id: comment.id, propertyChildren: 'all'}).load(),
  ])
  const suggested = await Promise.all(targets.map(async blockId => ({blockId, content: await excerptOf(repo, blockId)})))
  // The dialog hands focus back on close, which would make the card the
  // comment is leaving the active one again.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  const targetId = await openDialog(OwnThreadPicker, {
    workspaceId: comment.peek()?.workspaceId ?? '',
    suggested,
    exclude: subtree.map(row => row.id),
  })
  if (targetId === null) return
  await moveToOwnThread(repo, {commentId: comment.id, targetId})
  if (panelId) await goToComment(repo, panelId, comment.id)
}
