import type {BlockData} from '@/data/api'
import {useRepo} from '@/context/repo.js'
import {useHandle} from '@/hooks/block.js'
import {resolveAnchor} from './anchor.ts'
import {threadAnchorOf, threadTargetIdOf} from './schema.ts'

/** Where a thread's quote stands in its target right now; `deleted` for a
 *  target that is gone. A whole-block thread is always exact. */
export type AnchorState = 'exact' | 'moved' | 'stale' | 'deleted'

/** What a thread's card says about an anchor that isn't exact. */
export const ANCHOR_BADGES: Record<Exclude<AnchorState, 'exact'>, string> = {
  moved: 'text around it changed',
  stale: 'quoted text changed',
  deleted: 'on a deleted block',
}

type RootRow = Pick<BlockData, 'content' | 'properties'>

/** The root's anchor state, live against its target's content, and that
 *  content (null when the target is gone). */
export const useAnchorState = (root: RootRow): {state: AnchorState; targetContent: string | null} => {
  const repo = useRepo()
  const targetId = threadTargetIdOf(root) ?? ''
  const targetContent = useHandle(repo.block(targetId), {selector: data => data && !data.deleted ? data.content : null})
  if (targetContent === null) return {state: 'deleted', targetContent}
  const anchor = threadAnchorOf(root)
  return {state: anchor.kind === 'block' ? 'exact' : resolveAnchor(targetContent, anchor).state, targetContent}
}
