// User-intent navigation primitive. Single entry point for "go to a block"
// and "open a block in a new panel" by mutating tab-local panel rows. The
// panel layout projection observes those rows and keeps the URL in sync.
//
// Treated as a runtime service (like Repo or AppRuntime), not a facet:
// navigation is a fundamental action with one canonical implementation, not
// an extensibility surface that composes contributions. If extensions
// later need to intercept navigation (e.g. a block type that opens in a
// custom viewer rather than as a focused block), this is where a
// navigationInterceptorFacet would plug in — navigate() would consult
// `runtime.read(...)` before falling through to the default URL / event
// implementation. Keeping the API a plain function for now lets that hook
// be added without re-plumbing call sites.
import { useCallback, type MouseEvent } from 'react'
import type { Repo } from '@/data/repo'
import { useRepo } from '@/context/repo'
import { useBlockContext } from '@/context/block'
import { getPerTabBlock, getUIStateBlock } from '@/data/globalState'
import { navigateInPanel } from './panelHistory'
import { getTabId } from '@/utils/tabId'
import { insertPanelRow, insertSidebarStackedPanel } from '@/utils/panelLayoutProjection'

export type NavigationTarget = 'focused' | 'main' | 'new-panel' | 'sidebar-stack'

export interface NavigateInput {
  blockId: string
  /** Defaults to repo.activeWorkspaceId. */
  workspaceId?: string
  target: NavigationTarget
  /** When target='focused', the panel the click came from. Omit to
   *  route to the current tab's main panel (global QuickFind, etc.). */
  panelId?: string
  /** Alias for panelId on the new-panel path; kept distinct for clarity at
   *  call sites. Also used by target='sidebar-stack'. Ignored on other
   *  targets. */
  sourcePanelId?: string
}

const resolvePerTabBlock = async (repo: Repo, workspaceId: string) => {
  const uiState = await getUIStateBlock(repo, workspaceId, repo.user, {})
  return getPerTabBlock(uiState, getTabId())
}

const navigateMainPanel = async (
  repo: Repo,
  workspaceId: string,
  blockId: string,
): Promise<void> => {
  const perTabBlock = await resolvePerTabBlock(repo, workspaceId)
  const panels = await perTabBlock.children.load()
  const firstPanel = panels[0]
  if (firstPanel) {
    await navigateInPanel(repo.block(firstPanel.id), blockId)
    return
  }
  await insertPanelRow(repo, perTabBlock, blockId)
}

export const navigate = (repo: Repo, input: NavigateInput): void => {
  const workspaceId = input.workspaceId ?? repo.activeWorkspaceId
  if (!workspaceId) return

  if (input.target === 'new-panel') {
    void resolvePerTabBlock(repo, workspaceId)
      .then(perTabBlock => insertPanelRow(repo, perTabBlock, input.blockId, {
        afterPanelId: input.sourcePanelId,
      }))
    return
  }

  if (input.target === 'sidebar-stack') {
    void resolvePerTabBlock(repo, workspaceId)
      .then(perTabBlock => insertSidebarStackedPanel(repo, perTabBlock, input.blockId, {
        sourcePanelId: input.sourcePanelId,
      }))
    return
  }

  if (input.target === 'main' || !input.panelId) {
    void navigateMainPanel(repo, workspaceId, input.blockId)
    return
  }

  void navigateInPanel(repo.block(input.panelId), input.blockId)
}

export const useNavigate = () => {
  const repo = useRepo()
  return useCallback((input: NavigateInput) => navigate(repo, input), [repo])
}

export interface BlockLinkClickContext {
  blockId: string
  workspaceId: string
}

/** Standard click handler for in-document block links — wikilinks, block
 *  refs, bullets, and other anchors whose href encodes a block target.
 *  Centralises the modifier-key policy so individual components don't
 *  re-implement it (and drift apart):
 *    - shift+click: open in the Roam-style vertical sidebar stack
 *    - shift+alt+click: open in a new side panel
 *    - alt+click: open in the current tab's main panel
 *    - plain primary click: navigate the panel the click came from
 *    - cmd / ctrl / non-primary: fall through to the href so the
 *      browser handles new-tab and middle-click as usual
 *  Always stops propagation so a surrounding click handler doesn't swallow
 *  the navigation. */
export const handleBlockLinkClick = (
  e: MouseEvent,
  navigate: (input: NavigateInput) => void,
  panelId: string | undefined,
  {blockId, workspaceId}: BlockLinkClickContext,
): void => {
  e.stopPropagation()
  if (e.shiftKey && e.altKey && !e.metaKey && !e.ctrlKey && e.button === 0) {
    e.preventDefault()
    navigate({blockId, workspaceId, target: 'new-panel', sourcePanelId: panelId})
    return
  }
  if (e.shiftKey && !e.metaKey && !e.ctrlKey && e.button === 0) {
    e.preventDefault()
    navigate({blockId, workspaceId, target: 'sidebar-stack', sourcePanelId: panelId})
    return
  }
  if (e.altKey && !e.metaKey && !e.ctrlKey && e.button === 0) {
    e.preventDefault()
    navigate({blockId, workspaceId, target: 'main'})
    return
  }
  if (e.metaKey || e.ctrlKey || e.button !== 0) return
  e.preventDefault()
  navigate({blockId, workspaceId, target: 'focused', panelId})
}

export const useBlockLinkClick = ({blockId, workspaceId}: BlockLinkClickContext) => {
  const navigate = useNavigate()
  const {panelId} = useBlockContext()
  return useCallback((e: MouseEvent) => {
    handleBlockLinkClick(e, navigate, panelId, {blockId, workspaceId})
  }, [navigate, panelId, blockId, workspaceId])
}
