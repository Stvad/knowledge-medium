/**
 * A block link clicked in a comment, to a block of the page its panel shows,
 * goes to that block in the page: expanded to, focused and scrolled to, with
 * the page and its cards kept. A comment is read beside its page; navigating
 * the panel to the block would replace the page under the card.
 *
 * And while the pointer is over a comment, the blocks of the page it links
 * are outlined.
 */

import {ChangeScope} from '@/data/api'
import {revealChildren} from '@/data/mutators'
import {focusBlock, isCollapsedProp, topLevelBlockIdProp} from '@/data/properties'
import {decodeRowProperty} from '@/data/rowProperty'
import type {BlockData} from '@/data/api'
import type {Block} from '@/data/block'
import type {Repo} from '@/data/repo'
import {scopeRowBlockId, scopeRowSelector} from '@/extensions/blockInteraction.js'
import {navigate, navigationVerb} from '@/utils/navigation'
import {panelRenderScopeId} from '@/utils/renderScope'
import {revealLanding, threadLanding} from './threadNavigation.ts'
import {isCardRenderScopeId} from './uiStore.ts'

/** Expand what hides `blockId` in the page `panel` shows. False, with
 *  nothing written, when the block isn't on that page, or a viewer would have
 *  to expand something. */
const revealInPage = async (repo: Repo, panel: Block, blockId: string): Promise<boolean> => {
  await panel.load()
  const topLevelBlockId = panel.peekProperty(topLevelBlockIdProp)
  if (!topLevelBlockId) return false
  if (topLevelBlockId === blockId) return true
  const {ancestors} = await repo.query.ancestors({id: blockId}).load()
  const at = ancestors.findIndex(ancestor => ancestor.id === topLevelBlockId)
  if (at < 0) return false
  const collapsed = ancestors.slice(0, at).filter(ancestor => decodeRowProperty(ancestor, isCollapsedProp))
  if (collapsed.length === 0) return true
  if (repo.isReadOnly) return false
  await repo.tx(async tx => {
    for (const ancestor of collapsed) await revealChildren(tx, ancestor.id)
  }, {scope: ChangeScope.BlockDefault, description: 'reveal linked block'})
  return true
}

const pageScopeOf = (panel: Block): string => panelRenderScopeId(panel.id, panel.peekProperty(topLevelBlockIdProp)!)

export const commentLinkNavigationContribution = navigationVerb.decorator(next => async request => {
  const {repo, input} = request
  if (input.target !== 'panel' || input.origin !== 'follow-link' || !isCardRenderScopeId(input.sourceRenderScopeId)) {
    return next(request)
  }
  const panel = repo.block(input.panelId)
  // The page itself is a navigation as before: it lands at the top.
  if (await panel.load() && panel.peekProperty(topLevelBlockIdProp) === input.blockId) return next(request)
  if (!await revealInPage(repo, panel, input.blockId)) return next(request)
  await focusBlock(panel, input.blockId, {renderScopeId: pageScopeOf(panel)})
  return {panelId: input.panelId, blockId: input.blockId, workspaceId: input.workspaceId}
}, {source: 'annotations'})

/** Show `commentId` in its card, focused, keeping the page `panelId` shows
 *  when the card's target is on it, else navigating there. */
export const goToComment = async (repo: Repo, panelId: string, commentId: string): Promise<void> => {
  const landing = await threadLanding(repo, commentId)
  const panel = repo.block(panelId)
  if (landing && await revealInPage(repo, panel, landing.targetId)) {
    await revealLanding(repo, panelId, pageScopeOf(panel), landing, commentId)
    return
  }
  await navigate(repo, {blockId: commentId, target: 'panel', panelId})
}

const LINKED_ATTRIBUTE = 'data-comment-linked'

/** The blocks `comment` links by its content. */
export const linkedBlockIds = (comment: BlockData): ReadonlySet<string> =>
  new Set(comment.references.filter(ref => !ref.sourceField).map(ref => ref.id))

/** Outline the rows of `panelEl`'s page that `comment` links; returns the
 *  undo. A row's own content is outlined, not its subtree. */
export const outlineLinkedBlocks = (repo: Repo, panelEl: HTMLElement, comment: BlockData): (() => void) => {
  const panelId = panelEl.dataset.panelId
  const topLevelBlockId = panelId && repo.block(panelId).peekProperty(topLevelBlockIdProp)
  const linked = linkedBlockIds(comment)
  if (!panelId || !topLevelBlockId || linked.size === 0) return () => {}
  const outlined: Element[] = []
  for (const row of panelEl.querySelectorAll<HTMLElement>(scopeRowSelector(panelRenderScopeId(panelId, topLevelBlockId)))) {
    const id = scopeRowBlockId(row)
    if (!id || !linked.has(id)) continue
    const content = row.querySelector('[data-block-visibility-target="true"]') ?? row
    content.setAttribute(LINKED_ATTRIBUTE, '')
    outlined.push(content)
  }
  return () => { for (const el of outlined) el.removeAttribute(LINKED_ATTRIBUTE) }
}
