// User-intent navigation primitive. Single entry point for "go to a block"
// and "open a block in a new panel" — collapsing the previous split between
// writeAppHash() and the 'open-panel' CustomEvent into one verb.
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
import { isMainPanel } from '@/data/globalState'
import { navigateInPanel } from './panelHistory'
import { writeAppHash } from './routing'

export type NavigationTarget = 'focused' | 'new-panel'

export interface NavigateInput {
  blockId: string
  /** Defaults to repo.activeWorkspaceId. */
  workspaceId?: string
  target: NavigationTarget
  /** When target='new-panel', the panel that initiated this so the panel
   *  manager can position the new panel adjacent to it.
   *  When target='focused', the panel the click came from — main panel
   *  navigation goes to the URL hash, side-panel navigation stays inside
   *  that panel via panelHistory. Omit to fall back to URL hash navigation
   *  (e.g. global QuickFind, where there's no source panel). */
  panelId?: string
  /** Alias for panelId on the new-panel path; kept distinct for clarity at
   *  call sites. Ignored on other targets. */
  sourcePanelId?: string
}

export const navigate = (repo: Repo, input: NavigateInput): void => {
  const workspaceId = input.workspaceId ?? repo.activeWorkspaceId
  if (!workspaceId) return

  if (input.target === 'new-panel') {
    window.dispatchEvent(new CustomEvent('open-panel', {
      detail: {
        blockId: input.blockId,
        sourcePanelId: input.sourcePanelId,
      },
    }))
    return
  }

  // target === 'focused'. Three cases:
  //   1. No panelId — caller has no panel context (global QuickFind, etc.).
  //      Fall through to URL hash, which the main panel reads.
  //   2. panelId points at the main panel — same as (1); the main panel's
  //      displayed block is URL-driven, so writing topLevelBlockIdProp
  //      directly wouldn't change the view.
  //   3. panelId points at a side panel — write the panel-local top-level
  //      property via navigateInPanel so the side panel actually moves and
  //      its back/forward stack records the prior block.
  if (input.panelId) {
    const panelBlock = repo.block(input.panelId)
    if (panelBlock.peek() && !isMainPanel(panelBlock)) {
      void navigateInPanel(panelBlock, input.blockId)
      return
    }
  }
  writeAppHash(workspaceId, input.blockId)
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
 *    - shift+click: open in a new side panel
 *    - plain primary click: navigate the panel the click came from
 *      (main panel → URL hash; side panel → topLevelBlockIdProp)
 *    - cmd / ctrl / alt / non-primary: fall through to the href so the
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
  if (e.shiftKey) {
    e.preventDefault()
    navigate({blockId, workspaceId, target: 'new-panel', sourcePanelId: panelId})
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.button !== 0) return
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
