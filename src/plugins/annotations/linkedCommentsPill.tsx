/**
 * A gutter pill on a block that comments elsewhere link: how many, and a click
 * shows the next of them in its card (`goToComment`).
 */

import {useRef} from 'react'
import {MessageSquareQuote} from 'lucide-react'
import {GutterPill} from '@/components/GutterPill.js'
import {useBlockContext} from '@/context/block.js'
import {useRepo} from '@/context/repo.js'
import type {BlockGutterItem, BlockGutterItemContribution} from '@/extensions/blockInteraction.js'
import {useHandle, useWorkspaceId} from '@/hooks/block.js'
import type {BlockRenderer} from '@/types.js'
import {reportFailure} from './actions.ts'
import {goToComment} from './commentLinks.ts'
import {COMMENT_LINKS_FOR_BLOCK_QUERY, type CommentLink} from './queries.ts'

const NO_LINKS: readonly CommentLink[] = Object.freeze([])

const LinkedCommentsPill: BlockRenderer = ({block}) => {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')
  const links = useHandle(
    repo.query[COMMENT_LINKS_FOR_BLOCK_QUERY]({workspaceId, id: block.id}),
    {selector: loaded => loaded ?? NO_LINKS},
  )
  const {panelId} = useBlockContext()
  /** Which link the next click shows: each click moves to the next. */
  const next = useRef(0)
  if (links.length === 0 || !panelId) return null
  const label = `Linked from ${links.length} comment${links.length === 1 ? '' : 's'}`
  const onClick = () => {
    const link = links[next.current % links.length]
    next.current += 1
    goToComment(repo, panelId, link.commentId).catch(reportFailure)
  }
  return (
    <GutterPill
      count={links.length}
      expanded={false}
      onClick={event => { event.stopPropagation(); onClick() }}
      label={label}
      icon={MessageSquareQuote}
    />
  )
}

const linkedCommentsPillItem: BlockGutterItem = {corner: 'top-right', component: LinkedCommentsPill}

/** Outline blocks only: a comment linking a comment is part of a card. */
export const linkedCommentsPillContribution: BlockGutterItemContribution = ctx =>
  ctx.blockContext?.isNestedSurface ? null : linkedCommentsPillItem
