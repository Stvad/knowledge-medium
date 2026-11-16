/**
 * A block link clicked in a comment, to a block of the page its panel shows,
 * goes to that block in the page: expanded to, focused and scrolled to, with
 * the page and its cards kept. A comment is read beside its page; navigating
 * the panel to the block would replace the page under the card.
 *
 * And while the pointer is over a comment, the blocks of the page it links
 * are outlined.
 */

import {ChangeScope, type BlockData} from '@/data/api'
import type {Block} from '@/data/block'
import {revealChildren} from '@/data/mutators'
import {focusBlock, isCollapsedProp, topLevelBlockIdProp, uiStateRenderScopeId} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {decodeRowProperty} from '@/data/rowProperty'
import {navigate, navigationVerb} from '@/utils/navigation'
import {panelRenderScopeId} from '@/utils/renderScope'
import {zoomPath} from '@/utils/surfaceZoom'
import {revealLanding, threadLanding} from './threadNavigation.ts'
import {linkedBlockIds} from './threads.ts'
import {isCardRenderScopeId} from './uiStore.ts'

/** Expand what hides `blockId` in the page `panel` shows. False, with
 *  nothing written, when the block isn't on that page, or a viewer would have
 *  to expand something. */
const revealInPage = async (repo: Repo, panel: Block, blockId: string): Promise<boolean> => {
  await panel.load()
  const topLevelBlockId = panel.peekProperty(topLevelBlockIdProp)
  if (!topLevelBlockId) return false
  if (topLevelBlockId === blockId) return true
  const path = zoomPath((await repo.query.ancestors({id: blockId}).load()).ancestors, topLevelBlockId)
  if (!path) return false
  const collapsed = path.filter(ancestor => decodeRowProperty(ancestor, isCollapsedProp))
  if (collapsed.length === 0) return true
  if (repo.isReadOnly) return false
  await repo.tx(async tx => {
    for (const ancestor of collapsed) await revealChildren(tx, ancestor.id)
  }, {scope: ChangeScope.BlockDefault, description: 'reveal linked block'})
  return true
}

export const commentLinkNavigationContribution = navigationVerb.decorator(next => async request => {
  const {repo, input} = request
  if (input.target !== 'panel' || input.origin !== 'follow-link' || !isCardRenderScopeId(input.sourceRenderScopeId)) {
    return next(request)
  }
  const panel = repo.block(input.panelId)
  await panel.load()
  // A link to the page itself navigates, landing at its top.
  if (panel.peekProperty(topLevelBlockIdProp) === input.blockId) return next(request)
  if (!await revealInPage(repo, panel, input.blockId)) return next(request)
  await focusBlock(panel, input.blockId, {renderScopeId: uiStateRenderScopeId(panel, input.blockId)})
  return {panelId: input.panelId, blockId: input.blockId, workspaceId: input.workspaceId}
}, {source: 'annotations'})

/** Show `commentId` in its card, focused, keeping the page `panelId` shows
 *  when the card's target is on it, else navigating there. A viewer can't
 *  expand the comments that hide it, so then it opens the comment itself, as
 *  thread navigation does. */
export const goToComment = async (repo: Repo, panelId: string, commentId: string): Promise<void> => {
  const landing = await threadLanding(repo, commentId)
  const panel = repo.block(panelId)
  const viewerBlocked = repo.isReadOnly && (landing?.collapsed.length ?? 0) > 0
  if (landing && !viewerBlocked && await revealInPage(repo, panel, landing.targetId)) {
    await revealLanding(repo, panelId, uiStateRenderScopeId(panel, landing.targetId), landing, commentId)
    return
  }
  await navigate(repo, {blockId: commentId, target: 'panel', panelId})
}

const LINKED_ATTRIBUTE = 'data-comment-linked'

/** How many hovered comments outline each row: a reply's card renders inside
 *  its parent comment, so both are hovered at once, and they can link the
 *  same row. */
const outlinedBy = new WeakMap<Element, number>()

const outline = (el: Element, delta: 1 | -1): void => {
  const count = (outlinedBy.get(el) ?? 0) + delta
  outlinedBy.set(el, count)
  if (count > 0) el.setAttribute(LINKED_ATTRIBUTE, '')
  else el.removeAttribute(LINKED_ATTRIBUTE)
}

/** Outline the rows of `panelEl`'s page that `comment` links; returns the
 *  undo. A row's own content is outlined, not its subtree. */
export const outlineLinkedBlocks = (repo: Repo, panelEl: HTMLElement, comment: BlockData): (() => void) => {
  const panelId = panelEl.dataset.panelId
  const topLevelBlockId = panelId && repo.block(panelId).peekProperty(topLevelBlockIdProp)
  if (!panelId || !topLevelBlockId) return () => {}
  const scope = CSS.escape(panelRenderScopeId(panelId, topLevelBlockId))
  const outlined: Element[] = []
  for (const id of linkedBlockIds(comment)) {
    const row = panelEl.querySelector(`[data-block-shell][data-block-id="${CSS.escape(id)}"][data-render-scope-id="${scope}"]`)
    if (!row) continue
    const content = row.querySelector('[data-block-visibility-target="true"]') ?? row
    outline(content, 1)
    outlined.push(content)
  }
  return () => { for (const el of outlined) outline(el, -1) }
}
