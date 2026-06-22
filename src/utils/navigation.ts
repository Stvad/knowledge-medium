// User-intent navigation. `navigate()` is the entry point for "go to a block"
// and "open a block in a panel": it resolves the intent through
// `navigationVerb`, then applies the result by mutating layout-session panel
// rows (the panel layout projection observes those rows and keeps the URL in
// sync) and returns where it landed.
//
// `navigationVerb` is the extension seam for navigation INTENT — plugins
// observe navigations (before/after), rewrite the intent (a decorator calling
// `next` with a changed input), veto it (return `null`), or replace it
// wholesale (`navigationVerb.impl`). It's effectful and uses the verb's default
// `onError: 'rethrow'`, so a throwing override fails that one navigation
// (logged by `navigate`) without re-running the default — no double-navigation.
//
// Scope: the intent layer only. The lower layers are deliberately NOT routed
// through `navigate()`:
//   - The in-panel content swap + per-panel back/forward live in `panelHistory`
//     (`navigateInPanel`/`goBack`/`goForward`); back/forward is history
//     traversal restoring a snapshot, not a "go to block" intent.
//   - URL-driven restoration (deep links, browser back/forward) is the inverse
//     projection (URL → rows, in `panelLayoutProjection`); routing it through
//     `navigate()` (rows → URL) would re-push history and loop.
// Both still funnel through `writePanelContent` — the single choke for content
// swaps on existing panels (a new panel's initial content is set in
// `createPanelRowInTx`), where a future observe seam would hook.
import { useCallback, type MouseEvent } from 'react'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { defineVerbFacet } from '@/facets/verbFacet'
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

/** Where a navigation landed: the panel showing the block, and the block. The
 *  resolved result of `navigate()` / `navigationVerb`. */
export interface NavigationResult {
  panelId: string
  blockId: string
}

/** Input to `navigationVerb`: the requested navigation, the resolved workspace,
 *  and the live repo — impls/observers need it to inspect the target block,
 *  read prefs, or perform a fully custom navigation. */
export interface NavigationRequest {
  repo: Repo
  /** `input.workspaceId ?? repo.activeWorkspaceId`, resolved once up front. */
  workspaceId: string
  input: NavigateInput
}

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
): Promise<NavigationResult> => {
  const layoutSessionBlock = await resolveLayoutSessionBlock(repo, workspaceId)
  const panels = await panelRowsForLayoutSession(layoutSessionBlock)
  const firstPanel = panels[0]
  if (firstPanel) {
    await setActivePanel(layoutSessionBlock, firstPanel.id)
    await navigateInPanel(repo.block(firstPanel.id), blockId)
    return {panelId: firstPanel.id, blockId}
  }
  const panelId = await insertPanelRow(repo, layoutSessionBlock, blockId)
  return {panelId, blockId}
}

const navigateActivePanel = async (
  repo: Repo,
  workspaceId: string,
  blockId: string,
): Promise<NavigationResult> => {
  const layoutSessionBlock = await resolveLayoutSessionBlock(repo, workspaceId)
  const panel = await resolveActivePanelRow(layoutSessionBlock)
  if (panel) {
    await setActivePanel(layoutSessionBlock, panel.id)
    await navigateInPanel(repo.block(panel.id), blockId)
    return {panelId: panel.id, blockId}
  }
  const panelId = await insertPanelRow(repo, layoutSessionBlock, blockId)
  return {panelId, blockId}
}

const navigateExplicitPanel = async (
  repo: Repo,
  workspaceId: string,
  panelId: string,
  blockId: string,
): Promise<NavigationResult> => {
  await navigateInPanel(repo.block(panelId), blockId)
  void resolveLayoutSessionBlock(repo, workspaceId)
    .then(layoutSessionBlock => setActivePanel(layoutSessionBlock, panelId))
    .catch(error => {
      console.error('[navigation] Failed to mark panel active after navigation', error)
    })
  return {panelId, blockId}
}

/** Apply a resolved navigation: the target-dispatch ladder that mutates
 *  layout-session panel rows, returning where it landed. Re-resolves the
 *  workspace from the (possibly rewritten) input so a resolver that retargets
 *  workspaces still lands correctly. This is `navigationVerb`'s default impl. */
const applyNavigation = async (
  {repo, input}: NavigationRequest,
): Promise<NavigationResult | null> => {
  const workspaceId = input.workspaceId ?? repo.activeWorkspaceId
  if (!workspaceId) return null

  switch (input.target) {
    case 'new-panel': {
      const layoutSessionBlock = await resolveLayoutSessionBlock(repo, workspaceId)
      const panelId = await insertPanelRow(repo, layoutSessionBlock, input.blockId, {
        afterPanelId: input.sourcePanelId,
      })
      return {panelId, blockId: input.blockId}
    }
    case 'sidebar-stack': {
      const layoutSessionBlock = await resolveLayoutSessionBlock(repo, workspaceId)
      const panelId = await insertSidebarStackedPanel(repo, layoutSessionBlock, input.blockId, {
        sourcePanelId: input.sourcePanelId,
      })
      return {panelId, blockId: input.blockId}
    }
    case 'main':
      return navigateMainPanel(repo, workspaceId, input.blockId)
    case 'active':
      return navigateActivePanel(repo, workspaceId, input.blockId)
    case 'panel':
      return navigateExplicitPanel(repo, workspaceId, input.panelId, input.blockId)
  }
}

/**
 * The navigation INTENT seam. Plugins contribute:
 *   - `navigationVerb.before/after` — observe navigations (history, analytics);
 *     `after` gets the request + the `NavigationResult | null` it resolved to.
 *     (An observer must not unconditionally call `navigate()` itself — it would
 *     re-enter the verb and loop.)
 *   - `navigationVerb.impl` — replace navigation wholesale (`req => myNav(req)`).
 *   - `navigationVerb.decorator` — wrap it: rewrite the intent (call `next` with
 *     a changed `input`) or veto it (return `null` without calling `next`).
 * With no contributions, `run` returns `applyNavigation(request)`, so
 * `navigate()` behaves exactly as before the seam existed. Effectful verb on the
 * default `onError: 'rethrow'`: a throwing override fails that one navigation
 * (logged by `navigate`), never double-applies.
 */
export const navigationVerb = defineVerbFacet<NavigationRequest, NavigationResult | null>({
  id: 'core.navigate',
  defaultImpl: applyNavigation,
  // Untyped dynamic plugins can return `undefined`/a wrong shape; an invalid
  // result rejects (rethrow) → `navigate` logs and resolves to null, rather
  // than a malformed result reaching callers that read `.panelId`.
  validateResult: result => {
    if (result === null) return true
    const r = result as Partial<NavigationResult>
    return typeof r.panelId === 'string' && typeof r.blockId === 'string'
  },
})

/** Go to a block / open it in a panel, returning where it landed (or `null` if
 *  vetoed, no workspace, or it failed). Resolves the intent through
 *  `navigationVerb`, then the default impl applies it. **Never rejects** —
 *  errors are logged and become `null` — so the many fire-and-forget callers can
 *  ignore the returned promise safely. The verb runs when a workspace resolves
 *  and a facet runtime is installed (always in production); the early-boot /
 *  minimal-harness path applies the default directly. */
export const navigate = async (
  repo: Repo,
  input: NavigateInput,
): Promise<NavigationResult | null> => {
  const workspaceId = input.workspaceId ?? repo.activeWorkspaceId
  if (!workspaceId) return null

  const request: NavigationRequest = {repo, workspaceId, input}
  const runtime = repo.facetRuntime
  try {
    return runtime
      ? await navigationVerb.run(runtime, request)
      : await applyNavigation(request)
  } catch (error) {
    console.error('[navigation] navigate failed', error)
    return null
  }
}

export const useNavigate = () => {
  const repo = useRepo()
  return useCallback((input: NavigateInput) => navigate(repo, input), [repo])
}

export const navigateFromGlobalCommand = (
  repo: Repo,
  input: GlobalCommandNavigateInput,
): Promise<NavigationResult | null> =>
  navigate(repo, {
    ...input,
    target: isMobileViewport() ? 'active' : 'main',
  })

export const useNavigateFromGlobalCommand = () => {
  const repo = useRepo()
  return useCallback(
    (input: GlobalCommandNavigateInput) => navigateFromGlobalCommand(repo, input),
    [repo],
  )
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

/** What a plain (no-modifier) primary click should do. Shift / alt always
 *  follow the canonical policy regardless of this setting.
 *  - `'follow-link'` (default): navigate the panel the click came from —
 *    `{target: 'panel'}` when inside a panel, `{target: 'active'}` otherwise.
 *    Matches `<a>` and inline-block-link semantics.
 *  - `'navigator'`: open in the global-command target (main on desktop,
 *    active on mobile). Use for command-bar–style UIs whose job is "go
 *    to this thing" regardless of where the click came from — quick find,
 *    daily-note picker, recents button, left-sidebar shortcuts, filter
 *    config gear icons, map "Open" buttons. */
export type BlockOpenerPlainClick = 'follow-link' | 'navigator'

export interface BlockOpenerOptions {
  plainClick?: BlockOpenerPlainClick
}

/** Pure dispatch decision for the block opener: maps a click intent to
 *  one of three actions — open via the global-command path (navigator
 *  plain click), navigate with an explicit input (modifier or follow-link
 *  default), or do nothing (cmd/ctrl/middle click that should fall
 *  through to the browser). Exposed for tests; in production callers go
 *  through `useBlockOpener`. */
export type BlockOpenerAction =
  | {kind: 'global-command'}
  | {kind: 'navigate'; input: NavigateInput}
  | {kind: 'noop'}

export const blockOpenerAction = (
  intent: BlockLinkClickIntent,
  plainClick: BlockOpenerPlainClick,
  panelId: string | undefined,
  ctx: BlockLinkClickContext,
): BlockOpenerAction => {
  if (intent === 'native') return {kind: 'noop'}
  if (intent === 'default' && plainClick === 'navigator') return {kind: 'global-command'}
  const input = navigateInputFromBlockLinkClickIntent(intent, panelId, ctx)
  return input ? {kind: 'navigate', input} : {kind: 'noop'}
}

/** The standard way for plugins and components to wire a clickable surface
 *  that opens a block — links, buttons, map pins, calendar cells, anything.
 *  Returns a modifier-aware onClick handler that honours the shift / alt
 *  policy documented on `handleBlockLinkClick`.
 *
 *  For dynamic surfaces where the target block isn't known until the click
 *  fires (e.g. breadcrumb chains, search result lists), use
 *  `useBlockOpener` instead and pass the block at call time. */
export const useOpenBlock = (
  {blockId, workspaceId}: OpenBlockContext,
  {plainClick = 'follow-link'}: BlockOpenerOptions = {},
) => {
  const opener = useBlockOpener({plainClick})
  return useCallback(
    (e: MouseEvent) => opener(e, {blockId, workspaceId}),
    [opener, blockId, workspaceId],
  )
}

/** Returns an opener `(event, {blockId, workspaceId?}) => void` for places
 *  that resolve the target block from the event (lists, breadcrumbs, map
 *  markers rendered in a loop). Single subscription per component instead
 *  of one hook per item. */
export const useBlockOpener = ({plainClick = 'follow-link'}: BlockOpenerOptions = {}) => {
  const navigate = useNavigate()
  const repo = useRepo()
  const {panelId} = useBlockContext()
  return useCallback(
    (e: MouseEvent, {blockId, workspaceId}: OpenBlockContext) => {
      const resolvedWorkspaceId = workspaceId ?? repo.activeWorkspaceId
      if (!resolvedWorkspaceId) return
      const action = blockOpenerAction(
        blockLinkClickIntent(e),
        plainClick,
        panelId,
        {blockId, workspaceId: resolvedWorkspaceId},
      )
      if (action.kind === 'noop') return
      e.stopPropagation()
      e.preventDefault()
      if (action.kind === 'global-command') {
        navigateFromGlobalCommand(repo, {blockId, workspaceId: resolvedWorkspaceId})
      } else {
        navigate(action.input)
      }
    },
    [navigate, repo, panelId, plainClick],
  )
}
