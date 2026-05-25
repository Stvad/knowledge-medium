// User-intent navigation primitive. Single entry point for "go to a block"
// and "open a block in a new panel" by mutating layout-session panel rows. The
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
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { useRepo } from '@/context/repo'
import { useBlockContext } from '@/context/block'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import { navigateInPanel } from './panelHistory'
import { getLayoutSessionId } from '@/utils/layoutSessionId'
import { activePanelIdProp } from '@/data/properties'
import {
  insertPanelRow,
  insertSidebarStackedPanel,
  panelBlockId,
  panelRowsInLayoutOrder,
} from '@/utils/panelLayoutProjection'

export type NavigateInput =
  | NavigatePanelInput
  | NavigateMainInput
  | NavigateActiveInput
  | NavigateNewPanelInput
  | NavigateSidebarStackInput

interface NavigateBaseInput {
  blockId: string
  /** Defaults to repo.activeWorkspaceId. */
  workspaceId?: string
}

export interface NavigatePanelInput extends NavigateBaseInput {
  target: 'panel'
  panelId: string
}

export interface NavigateMainInput extends NavigateBaseInput {
  target: 'main'
}

export interface NavigateActiveInput extends NavigateBaseInput {
  target: 'active'
}

export interface NavigateNewPanelInput extends NavigateBaseInput {
  target: 'new-panel'
  sourcePanelId?: string
}

export interface NavigateSidebarStackInput extends NavigateBaseInput {
  target: 'sidebar-stack'
  sourcePanelId?: string
}

export type GlobalCommandNavigateInput = NavigateBaseInput

const resolveLayoutSessionBlock = async (repo: Repo, workspaceId: string) => {
  const uiState = await getUIStateBlock(repo, workspaceId, repo.user, {})
  return getLayoutSessionBlock(uiState, getLayoutSessionId())
}

const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(max-width: 767px)').matches

const setActivePanel = async (
  layoutSessionBlock: Block,
  panelId: string | undefined,
): Promise<void> => {
  await layoutSessionBlock.load()
  if (layoutSessionBlock.peekProperty(activePanelIdProp) === panelId) return
  await layoutSessionBlock.set(activePanelIdProp, panelId)
}

const panelRowsForLayoutSession = async (
  layoutSessionBlock: Block,
) => panelRowsInLayoutOrder(
  layoutSessionBlock.id,
  await layoutSessionBlock.repo.query.subtree({id: layoutSessionBlock.id}).load(),
)

const resolveActivePanelRow = async (
  layoutSessionBlock: Block,
) => {
  await layoutSessionBlock.load()
  const panelRows = await panelRowsForLayoutSession(layoutSessionBlock)
  const activePanelId = layoutSessionBlock.peekProperty(activePanelIdProp)
  return panelRows.find(row => row.id === activePanelId) ?? panelRows.at(-1) ?? null
}

const navigateMainPanel = async (
  repo: Repo,
  workspaceId: string,
  blockId: string,
): Promise<void> => {
  const layoutSessionBlock = await resolveLayoutSessionBlock(repo, workspaceId)
  const panels = await panelRowsForLayoutSession(layoutSessionBlock)
  const firstPanel = panels[0]
  if (firstPanel) {
    await setActivePanel(layoutSessionBlock, firstPanel.id)
    await navigateInPanel(repo.block(firstPanel.id), blockId)
    return
  }
  await insertPanelRow(repo, layoutSessionBlock, blockId)
}

const navigateActivePanel = async (
  repo: Repo,
  workspaceId: string,
  blockId: string,
): Promise<void> => {
  const layoutSessionBlock = await resolveLayoutSessionBlock(repo, workspaceId)
  const panel = await resolveActivePanelRow(layoutSessionBlock)
  if (panel) {
    await setActivePanel(layoutSessionBlock, panel.id)
    await navigateInPanel(repo.block(panel.id), blockId)
    return
  }
  await insertPanelRow(repo, layoutSessionBlock, blockId)
}

const navigateExplicitPanel = async (
  repo: Repo,
  workspaceId: string,
  panelId: string,
  blockId: string,
): Promise<void> => {
  await navigateInPanel(repo.block(panelId), blockId)
  void resolveLayoutSessionBlock(repo, workspaceId)
    .then(layoutSessionBlock => setActivePanel(layoutSessionBlock, panelId))
    .catch(error => {
      console.error('[navigation] Failed to mark panel active after navigation', error)
    })
}

export const navigate = (repo: Repo, input: NavigateInput): void => {
  const workspaceId = input.workspaceId ?? repo.activeWorkspaceId
  if (!workspaceId) return

  if (input.target === 'new-panel') {
    void resolveLayoutSessionBlock(repo, workspaceId)
      .then(layoutSessionBlock => insertPanelRow(repo, layoutSessionBlock, input.blockId, {
        afterPanelId: input.sourcePanelId,
      }))
    return
  }

  if (input.target === 'sidebar-stack') {
    void resolveLayoutSessionBlock(repo, workspaceId)
      .then(layoutSessionBlock => insertSidebarStackedPanel(repo, layoutSessionBlock, input.blockId, {
        sourcePanelId: input.sourcePanelId,
      }))
    return
  }

  if (input.target === 'main') {
    void navigateMainPanel(repo, workspaceId, input.blockId)
    return
  }

  if (input.target === 'active') {
    void navigateActivePanel(repo, workspaceId, input.blockId)
    return
  }

  void navigateExplicitPanel(repo, workspaceId, input.panelId, input.blockId)
}

export const useNavigate = () => {
  const repo = useRepo()
  return useCallback((input: NavigateInput) => navigate(repo, input), [repo])
}

export const navigateFromGlobalCommand = (
  repo: Repo,
  input: GlobalCommandNavigateInput,
): void => {
  navigate(repo, {
    ...input,
    target: isMobileViewport() ? 'active' : 'main',
  })
}

export const useNavigateFromGlobalCommand = () => {
  const repo = useRepo()
  return useCallback((input: GlobalCommandNavigateInput) => {
    navigateFromGlobalCommand(repo, input)
  }, [repo])
}

export const resolveGlobalCommandTopLevelBlockId = async (
  repo: Repo,
  workspaceId = repo.activeWorkspaceId,
): Promise<string | null> => {
  if (!workspaceId) return null
  const layoutSessionBlock = await resolveLayoutSessionBlock(repo, workspaceId)
  if (isMobileViewport()) {
    const panel = await resolveActivePanelRow(layoutSessionBlock)
    return panel ? panelBlockId(panel) ?? null : null
  }

  const panels = await panelRowsForLayoutSession(layoutSessionBlock)
  return panels[0] ? panelBlockId(panels[0]) ?? null : null
}

export interface BlockLinkClickContext {
  blockId: string
  workspaceId: string
}

export interface BlockLinkClickModifierState {
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  button: number
}

export type BlockLinkClickIntent =
  | 'new-panel'
  | 'sidebar-stack'
  | 'main'
  | 'default'
  | 'native'

export const blockLinkClickIntent = (
  event: BlockLinkClickModifierState,
): BlockLinkClickIntent => {
  if (event.shiftKey && event.altKey && !event.metaKey && !event.ctrlKey && event.button === 0) {
    return 'new-panel'
  }
  if (event.shiftKey && !event.metaKey && !event.ctrlKey && event.button === 0) {
    return 'sidebar-stack'
  }
  if (event.altKey && !event.metaKey && !event.ctrlKey && event.button === 0) {
    return 'main'
  }
  if (event.metaKey || event.ctrlKey || event.button !== 0) return 'native'
  return 'default'
}

export const navigateInputFromBlockLinkClickIntent = (
  intent: BlockLinkClickIntent,
  panelId: string | undefined,
  {blockId, workspaceId}: BlockLinkClickContext,
): NavigateInput | null => {
  if (intent === 'new-panel') return {blockId, workspaceId, target: 'new-panel', sourcePanelId: panelId}
  if (intent === 'sidebar-stack') return {blockId, workspaceId, target: 'sidebar-stack', sourcePanelId: panelId}
  if (intent === 'main') return {blockId, workspaceId, target: 'main'}
  if (intent === 'default') {
    return panelId
      ? {blockId, workspaceId, target: 'panel', panelId}
      : {blockId, workspaceId, target: 'active'}
  }
  return null
}

/** Standard click handler for in-document block links — wikilinks, block
 *  refs, bullets, and other anchors whose href encodes a block target.
 *  Centralises the modifier-key policy so individual components don't
 *  re-implement it (and drift apart). Link-like controls that resolve a
 *  block asynchronously should use `blockLinkClickIntent` first, then call
 *  `navigateInputFromBlockLinkClickIntent` once they have a block id:
 *    - shift+click: open in the Roam-style vertical sidebar stack
 *    - shift+alt+click: open in a new side panel
 *    - alt+click: open in the current layout session's main panel
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
  const input = navigateInputFromBlockLinkClickIntent(
    blockLinkClickIntent(e),
    panelId,
    {blockId, workspaceId},
  )
  if (!input) return
  e.preventDefault()
  navigate(input)
}

export interface OpenBlockContext {
  blockId: string
  /** Defaults to repo.activeWorkspaceId. */
  workspaceId?: string
}

/** The standard way for plugins and components to wire a clickable surface
 *  that opens a block — links, buttons, map pins, calendar cells, anything.
 *  Returns a modifier-aware onClick handler that honours the shift / alt
 *  policy documented on `handleBlockLinkClick`.
 *
 *  For dynamic surfaces where the target block isn't known until the click
 *  fires (e.g. breadcrumb chains, search result lists), use
 *  `useBlockOpener` instead and pass the block at call time. */
export const useOpenBlock = ({blockId, workspaceId}: OpenBlockContext) => {
  const opener = useBlockOpener()
  return useCallback(
    (e: MouseEvent) => opener(e, {blockId, workspaceId}),
    [opener, blockId, workspaceId],
  )
}

/** Returns an opener `(event, {blockId, workspaceId?}) => void` for places
 *  that resolve the target block from the event (lists, breadcrumbs, map
 *  markers rendered in a loop). Single subscription per component instead
 *  of one hook per item. */
export const useBlockOpener = () => {
  const navigate = useNavigate()
  const repo = useRepo()
  const {panelId} = useBlockContext()
  return useCallback(
    (e: MouseEvent, {blockId, workspaceId}: OpenBlockContext) => {
      const resolvedWorkspaceId = workspaceId ?? repo.activeWorkspaceId
      if (!resolvedWorkspaceId) return
      handleBlockLinkClick(e, navigate, panelId, {blockId, workspaceId: resolvedWorkspaceId})
    },
    [navigate, repo, panelId],
  )
}
