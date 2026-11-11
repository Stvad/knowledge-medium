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
import {hasBlockType, focusBlock, isCollapsedProp, topLevelBlockIdProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {lazyBlockCacheKey, requestLazyMount} from '@/components/util/lazyMountRegistry.js'
import {decodeRowProperty} from '@/data/rowProperty'
import {navigationVerb, ZOOM_ORIGIN, ZOOM_OUT_ORIGIN, type NavigatePanelInput, type NavigationResult} from '@/utils/navigation'
import {panelRenderScopeId} from '@/utils/renderScope'
import {THREAD_TYPE, threadIsOpen, threadTargetIdOf} from './schema.ts'
import {zoomCrumbs} from './cardZoom.tsx'
import {cardOfRenderScopeId, cardRenderScopeId, isCardRenderScopeId, outerCardSurface, peekCardZoom, revealThread, setCardZoom, viewKey} from './uiStore.ts'

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

/** The render scope of each card of `landing`, outermost first, once the
 *  navigation has made the target its panel's top-level block; the navigated
 *  block is focused in the last. Each card's scope derives from the one
 *  around it; the outermost is a margin card where the margin is drawn. */
export const landingCardScopes = (panelId: string, landing: ThreadLanding, inMargin: boolean): string[] => {
  let scope = panelRenderScopeId(panelId, landing.targetId)
  return landing.threads.map((thread, depth) =>
    scope = cardRenderScopeId(depth === 0 && inMargin ? 'margin' : 'comments', scope, thread.id))
}

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
  const cardScopes = landingCardScopes(panelId, landing, outerCardSurface(panelId) === 'margin')
  // A card zoomed into another part of its thread would hide the block.
  for (const scope of cardScopes) {
    const zoomed = peekCardZoom(scope)
    if (zoomed !== undefined && !landing.rows.includes(zoomed)) setCardZoom(scope, null)
  }
  // Focus is the panel's, as `writePanelContent` sets it for the landing.
  await focusBlock(repo.block(panelId), blockId, {renderScopeId: cardScopes.at(-1)!})
}

/** A zoom made inside a card (a comment's bullet, Zoom In, zoom out) zooms
 *  the card, as one made in a panel's outline zooms the panel. Only one aimed
 *  at the card's own panel: a bullet opened in a new panel is a navigation.
 *  False where it is the panel's to handle: made elsewhere, or a zoom out of a
 *  card showing its whole thread. */
const zoomInsideCard = async (repo: Repo, input: NavigatePanelInput): Promise<boolean> => {
  const scope = input.sourceRenderScopeId
  if (scope === undefined || !isCardRenderScopeId(scope)) return false
  if (input.origin === ZOOM_ORIGIN) {
    const found = await threadRootOf(repo, input.blockId)
    if (!found) return false
    const zoomsIn = found.root.id !== input.blockId
    setCardZoom(scope, zoomsIn ? input.blockId : null)
    // As a panel shows its root's children whatever the root's collapse.
    if (zoomsIn && !repo.isReadOnly && decodeRowProperty((await repo.block(input.blockId).load())!, isCollapsedProp)) {
      await repo.tx(tx => revealChildren(tx, input.blockId), {scope: ChangeScope.BlockDefault, description: 'reveal comment'})
    }
    await focusBlock(repo.block(input.panelId), input.blockId, {renderScopeId: scope})
    return true
  }
  return input.origin === ZOOM_OUT_ORIGIN && zoomOutOfCard(repo, scope)
}

/** Steps the innermost zoomed card at or around `scope` out one level: a
 *  card inside another card's comment is inside that card's zoom. False when
 *  none is zoomed. */
const zoomOutOfCard = async (repo: Repo, scope: string): Promise<boolean> => {
  for (let at = scope; isCardRenderScopeId(at); at = cardOfRenderScopeId(at).parentRenderScopeId) {
    const zoomed = peekCardZoom(at)
    if (zoomed === undefined) continue
    const {ancestors} = await repo.query.ancestors({id: zoomed}).load()
    const crumbs = zoomCrumbs(ancestors, cardOfRenderScopeId(at).threadId)
    setCardZoom(at, crumbs?.at(-1)?.id ?? null)
    if (crumbs) return true
  }
  return false
}

export const threadNavigationContribution = navigationVerb.decorator(next => async request => {
  const {input} = request
  if (input.target === 'panel' && await zoomInsideCard(request.repo, input)) {
    // The panel shows what it showed.
    const shown = request.repo.block(input.panelId).peekProperty(topLevelBlockIdProp) ?? input.blockId
    return {panelId: input.panelId, blockId: shown, workspaceId: input.workspaceId}
  }
  const landing = await threadLanding(request.repo, request.input.blockId)
  // A viewer can't expand the comments that hide the block, so it opens the
  // block itself.
  if (!landing || (landing.collapsed.length > 0 && request.repo.isReadOnly)) return next(request)
  const result = await next({...request, input: {...request.input, blockId: landing.targetId}})
  if (result) await revealLanding(request.repo, result, landing, request.input.blockId)
  return result
}, {source: 'annotations'})
