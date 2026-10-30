/**
 * Navigating to a thread root, or to any comment in its thread, lands on the
 * thread's target instead, with the thread's card showing and the block
 * navigated to focused in it, which scrolls it into view. A thread is read
 * beside the text it is about. This covers a click on a range reference
 * (`((T))` links to the root), a search result that hits a root or a comment,
 * and a comment's bullet.
 */

import type {BlockData} from '@/data/api'
import {hasBlockType, focusBlock} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {navigationVerb, type NavigationResult} from '@/utils/navigation'
import {panelRenderScopeId, surfaceRenderScopeId} from '@/utils/renderScope'
import {THREAD_TYPE, threadIsOpen, threadTargetIdOf} from './schema.ts'
import {peekMarginShowing, revealThread, viewKey} from './uiStore.ts'

export interface ThreadLanding {
  /** Where the navigation lands: the outermost thread's target. */
  targetId: string
  /** The threads the navigated block sits in, outermost first. A thread
   *  anchored to a comment renders inside that comment's card, so each card is
   *  inside the one before it. */
  threads: {id: string; open: boolean}[]
}

/** The nearest thread root at or above `id`; a comment's root is above it. */
const threadRootOf = async (repo: Repo, id: string): Promise<BlockData | null> => {
  const block = await repo.load(id)
  if (!block) return null
  if (hasBlockType(block, THREAD_TYPE)) return block
  const {ancestors} = await repo.query['core.ancestors']({id}).load()
  return ancestors.find(ancestor => hasBlockType(ancestor, THREAD_TYPE)) ?? null
}

/** Where navigating to `blockId` should land instead, or null when it is in
 *  no thread, or its thread's target is missing or deleted (the thread is
 *  then the only place left to show it). */
export const threadLanding = async (repo: Repo, blockId: string): Promise<ThreadLanding | null> => {
  const threads: ThreadLanding['threads'] = []
  let at = blockId
  for (;;) {
    const root = await threadRootOf(repo, at)
    // A thread anchored, by hand, to a comment of itself would loop.
    if (!root || threads.some(thread => thread.id === root.id)) break
    const targetId = threadTargetIdOf(root)
    if (!targetId || !await repo.load(targetId)) break
    threads.unshift({id: root.id, open: threadIsOpen(root)})
    at = targetId
  }
  return threads.length === 0 ? null : {targetId: at, threads}
}

/** The render scope `blockId` has inside the cards of `landing`, once the
 *  navigation has made the target its panel's top-level block. Each card
 *  derives its scope from the one around it, as `ThreadCard` does; the
 *  outermost is a margin card where the margin is drawn. */
export const landingFocusScope = (panelId: string, landing: ThreadLanding, inMargin: boolean): string =>
  landing.threads.reduce(
    (scope, thread, depth) => surfaceRenderScopeId(depth === 0 && inMargin ? 'margin' : 'comments', scope, thread.id),
    panelRenderScopeId(panelId, landing.targetId),
  )

const revealLanding = async (
  repo: Repo,
  {panelId}: NavigationResult,
  landing: ThreadLanding,
  blockId: string,
): Promise<void> => {
  const outer = landing.threads[0]
  revealThread(panelId, viewKey(panelRenderScopeId(panelId, landing.targetId), landing.targetId), outer.id, outer.open)
  // Focus is the panel's, as `writePanelContent` sets it for the landing.
  await focusBlock(repo.block(panelId), blockId, {renderScopeId: landingFocusScope(panelId, landing, peekMarginShowing(panelId))})
}

export const threadNavigationContribution = navigationVerb.decorator(next => async request => {
  const landing = await threadLanding(request.repo, request.input.blockId)
  if (!landing) return next(request)
  const result = await next({...request, input: {...request.input, blockId: landing.targetId}})
  if (result) await revealLanding(request.repo, result, landing, request.input.blockId)
  return result
}, {source: 'annotations'})
