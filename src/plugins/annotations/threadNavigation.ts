/**
 * Navigating to a thread root, or to any comment in its thread, lands on the
 * thread's target instead, with the thread's card showing and the block
 * navigated to focused in it. A thread is read
 * beside the text it is about. This covers a click on a range reference
 * (`((T))` links to the root), a search result that hits a root or a comment,
 * and a comment's bullet.
 *
 * ACCEPTED: a URL (a new tab, a shared link) restores panels without
 * navigating, so it opens the root itself.
 */

import {ChangeScope, type BlockData} from '@/data/api'
import {revealChildren} from '@/data/mutators'
import {hasBlockType, focusBlock, isCollapsedProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {lazyBlockCacheKey, requestLazyMount} from '@/components/util/lazyMountRegistry.js'
import {decodeRowProperty} from '@/data/rowProperty'
import {navigationVerb, type NavigationResult} from '@/utils/navigation'
import {panelRenderScopeId} from '@/utils/renderScope'
import {THREAD_TYPE, threadIsOpen, threadTargetIdOf} from './schema.ts'
import {cardRenderScopeId, peekMarginShowing, revealThread, viewKey} from './uiStore.ts'

export interface ThreadLanding {
  /** Where the navigation lands: the outermost thread's target. */
  targetId: string
  /** The threads the navigated block sits in, outermost first. A thread
   *  anchored to a comment renders inside that comment's card, so each card is
   *  inside the one before it. */
  threads: {id: string; open: boolean}[]
  /** Collapsed blocks inside those cards that hide the navigated block. */
  collapsed: string[]
  /** The rows from the navigated block out through each card, which must be
   *  mounted for it to render. */
  rows: string[]
}

/** The nearest thread root at or above `id`, and the blocks that must be
 *  expanded for `id` to show in the root's card: its ancestors up to the
 *  root, the root included. */
const threadRootOf = async (repo: Repo, id: string): Promise<{root: BlockData; above: BlockData[]} | null> => {
  const block = await repo.block(id).load()
  if (!block) return null
  if (hasBlockType(block, THREAD_TYPE)) return {root: block, above: []}
  const {ancestors} = await repo.query.ancestors({id}).load()
  const at = ancestors.findIndex(ancestor => hasBlockType(ancestor, THREAD_TYPE))
  return at < 0 ? null : {root: ancestors[at], above: ancestors.slice(0, at + 1)}
}

/** Where navigating to `blockId` should land instead, or null when it is in
 *  no thread, or its thread's target is missing or deleted (the thread is
 *  then the only place left to show it).
 *
 *  The walk goes out through a thread anchored to a comment only while that
 *  thread is open: a comment's card shows its open threads only, so a closed
 *  one is shown on its comment as a target of its own. */
export const threadLanding = async (repo: Repo, blockId: string): Promise<ThreadLanding | null> => {
  const threads: ThreadLanding['threads'] = []
  const collapsed: string[] = []
  const rows: string[] = []
  let at = blockId
  for (;;) {
    const found = await threadRootOf(repo, at)
    // A thread anchored, by hand, to a comment of itself would loop.
    if (!found || threads.some(thread => thread.id === found.root.id)) break
    const {root, above} = found
    const targetId = threadTargetIdOf(root)
    if (!targetId || !await repo.block(targetId).load()) break
    const open = threadIsOpen(root)
    threads.unshift({id: root.id, open})
    collapsed.push(...above.filter(block => decodeRowProperty(block, isCollapsedProp)).map(block => block.id))
    rows.push(at, ...above.map(block => block.id))
    at = targetId
    if (!open) break
  }
  return threads.length === 0 ? null : {targetId: at, threads, collapsed, rows}
}

/** The render scope `blockId` has inside the cards of `landing`, once the
 *  navigation has made the target its panel's top-level block. Each card's
 *  scope derives from the one around it; the outermost is a margin card where
 *  the margin is drawn. */
export const landingFocusScope = (panelId: string, landing: ThreadLanding, inMargin: boolean): string =>
  landing.threads.reduce(
    (scope, thread, depth) => cardRenderScopeId(depth === 0 && inMargin ? 'margin' : 'comments', scope, thread.id),
    panelRenderScopeId(panelId, landing.targetId),
  )

/** The last landing's rows, wanted mounted until the next landing. A card
 *  mounts its rows lazily, and `FocusedRowLazyMount` walks a focused row's
 *  ancestors only up to the panel's top-level block, which a comment's chain
 *  never reaches. */
let landingRowWants: readonly (() => void)[] = []

const wantRowsMounted = (rows: readonly string[]): void => {
  for (const withdraw of landingRowWants) withdraw()
  landingRowWants = rows.map(id => requestLazyMount(lazyBlockCacheKey(id)))
}

const revealLanding = async (
  repo: Repo,
  {panelId}: NavigationResult,
  landing: ThreadLanding,
  blockId: string,
): Promise<void> => {
  const outer = landing.threads[0]
  revealThread(panelId, viewKey(panelRenderScopeId(panelId, landing.targetId), landing.targetId), outer.id, outer.open)
  wantRowsMounted(landing.rows)
  if (landing.collapsed.length > 0) {
    await repo.tx(async tx => {
      for (const id of landing.collapsed) await revealChildren(tx, id)
    }, {scope: ChangeScope.BlockDefault, description: 'reveal comment'})
  }
  // Focus is the panel's, as `writePanelContent` sets it for the landing.
  await focusBlock(repo.block(panelId), blockId, {renderScopeId: landingFocusScope(panelId, landing, peekMarginShowing(panelId))})
}

export const threadNavigationContribution = navigationVerb.decorator(next => async request => {
  const landing = await threadLanding(request.repo, request.input.blockId)
  // A viewer can't expand the comments that hide the block, so it opens the
  // block itself.
  if (!landing || (landing.collapsed.length > 0 && request.repo.isReadOnly)) return next(request)
  const result = await next({...request, input: {...request.input, blockId: landing.targetId}})
  if (result) await revealLanding(request.repo, result, landing, request.input.blockId)
  return result
}, {source: 'annotations'})
