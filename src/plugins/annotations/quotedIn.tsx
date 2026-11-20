/**
 * The quoters of a thread: the blocks holding a range reference `((T))` to its
 * root. A quote of part of B is shown on B's card, under "Quoted in", and not
 * among B's backlinks, since it references the excerpt and not B.
 */

import {useRepo} from '@/context/repo.js'
import type {BlockChildrenFooterContribution} from '@/extensions/blockInteraction.js'
import {useWorkspaceId} from '@/hooks/block.js'
import {LazyBlockEntry} from '@/plugins/backlinks/BlockEntry.js'
import {useBacklinks} from '@/plugins/backlinks/useBacklinks.js'
import type {BlockRenderer} from '@/types.js'
import {THREAD_TYPE} from './schema.ts'
import {inCard} from './ui.tsx'

/** Each quoter as a backlink entry: its breadcrumb above it, and editable in
 *  place. */
const QuotedIn: BlockRenderer = ({block}) => {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')
  const quoters = useBacklinks(block, workspaceId)
  if (quoters.length === 0) return null
  return (
    <section aria-label="Quoted in" className="mt-1 border-t pt-1">
      <div className="px-1 text-xs text-muted-foreground">Quoted in</div>
      {quoters.map(quoter => <LazyBlockEntry key={quoter.id} block={quoter} scopeId={`quoted-in:${quoter.id}`}/>)}
    </section>
  )
}

export const quotedInFooterContribution: BlockChildrenFooterContribution = ctx =>
  ctx.types.includes(THREAD_TYPE) && inCard(ctx.blockContext) ? QuotedIn : null
