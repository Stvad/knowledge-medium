/**
 * Moving a comment to a thread of its own: pick the block the new thread is
 * on, the blocks the comment links on its thread's page offered first
 * (`ownThreadTargets`), then write it (`moveToOwnThread`) and show the new
 * thread where the old one showed.
 */

import {useEffect, useRef, useState} from 'react'
import type {Block} from '@/data/block'
import {focusBlock, topLevelBlockIdProp} from '@/data/properties'
import {BlockSearchPicker} from '@/components/BlockSearchPicker.tsx'
import {useRepo} from '@/context/repo.js'
import {openDialog, type DialogContextProps} from '@/utils/dialogs.js'
import {panelRenderScopeId} from '@/utils/renderScope'
import {firstLine, truncate} from '@/utils/string.js'
import {showInfo} from '@/utils/toast.js'
import {reportFailure} from './actions.ts'
import {moveToOwnThread, ownThreadTargets} from './threads.ts'
import {cardRenderScopeId, outerCardSurface, revealThread, viewKey} from './uiStore.ts'

interface Session {
  suggested: {blockId: string; content: string}[]
  /** The comment and its replies: a thread on any of them is refused. */
  exclude: string[]
}

interface OwnThreadPickerProps {
  commentId: string
  workspaceId: string
}

const OwnThreadPicker = ({commentId, workspaceId, resolve, cancel}: DialogContextProps<string> & OwnThreadPickerProps) => {
  const repo = useRepo()
  const [session, setSession] = useState<Session | null>(null)
  const cancelRef = useRef(cancel)
  useEffect(() => { cancelRef.current = cancel })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [targets, subtree] = await Promise.all([
        ownThreadTargets(repo, commentId),
        repo.query.subtree({id: commentId, propertyChildren: 'all'}).load(),
      ])
      const suggested = await Promise.all(targets.map(async blockId =>
        ({blockId, content: firstLine((await repo.load(blockId))?.content ?? '')})))
      if (!cancelled) setSession({suggested, exclude: [commentId, ...subtree.map(row => row.id)]})
    })().catch(error => {
      // Nothing renders until the session lands, so a failure must close it.
      reportFailure(error)
      if (!cancelled) cancelRef.current()
    })
    return () => { cancelled = true }
  }, [repo, commentId])

  if (!session) return null
  return (
    <BlockSearchPicker
      title="Move to its own thread"
      description="The comment and its replies become a new thread on the block you pick."
      placeholder="Find the block it is about…"
      workspaceId={workspaceId}
      excludeBlockIds={session.exclude}
      suggestions={{heading: 'Linked in this comment', blocks: session.suggested}}
      onSelect={resolve}
      onCancel={cancel}
    />
  )
}

/** Ask where, move, and show the comment in its new thread's card, focused,
 *  in the panel it was shown in. */
export const moveCommentToOwnThread = async (comment: Block, panelId: string | undefined): Promise<void> => {
  const repo = comment.repo
  // The dialog hands focus back on close, which would make the card the
  // comment left the active one again.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  const targetId = await openDialog(OwnThreadPicker, {commentId: comment.id, workspaceId: comment.peek()?.workspaceId ?? ''})
  if (targetId === null) return
  const threadId = await moveToOwnThread(repo, {commentId: comment.id, targetId})
  const panel = panelId === undefined ? undefined : repo.block(panelId)
  const topLevelBlockId = panel?.peekProperty(topLevelBlockIdProp)
  if (panel && topLevelBlockId) {
    const rowScope = panelRenderScopeId(panel.id, topLevelBlockId)
    revealThread(panel.id, viewKey(rowScope, targetId), threadId, true)
    await focusBlock(panel, comment.id, {renderScopeId: cardRenderScopeId(outerCardSurface(panel.id), rowScope, threadId)})
  }
  const excerpt = truncate(firstLine((await repo.load(targetId))?.content ?? ''), 60)
  showInfo(`Moved to its own thread on “${excerpt}”.`)
}
