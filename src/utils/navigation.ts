// User-intent navigation, in two layers — each an extension seam:
//
//   1. INTENT POLICY (`navigationIntentVerb`): resolves a *gesture* (a click's
//      role + modifiers, or a global command) into a `NavigateInput` (which
//      block, which target panel) or `null` (no-op / let the browser handle the
//      href). Pure and synchronous by default; plugins remap the modifier
//      matrix, override the follow-link/navigator role, or redirect where
//      global commands land (active vs main) by decorating/replacing it.
//   2. EXECUTION (`navigationVerb`): applies a `NavigateInput` — the layout
//      mutation that shows the block — and returns where it landed. Effectful;
//      plugins observe (before/after), rewrite (by target / origin / block),
//      veto (return `null`), or replace it wholesale.
//
// `navigate(repo, input)` is the execution entry: it runs `navigationVerb` and
// returns the resolved destination. It **never rejects** (errors are logged →
// `null`), so the many fire-and-forget callers can ignore the promise. Gesture
// surfaces resolve a `NavigateInput` through the intent policy first
// (`useBlockOpener`, `navigateFromGlobalCommand`, `navigateFromGesture`), then
// hand it to `navigate`. Every `NavigateInput` can carry an `origin` tag so
// execution-layer decorators can redirect/observe by source, not just by the
// resolved target — gesture navigations get it from the policy (the surface
// role); programmatic callers set it explicitly.
//
// Scope: the lower layers are deliberately NOT routed through this module:
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
  /** Semantic origin of this navigation — the surface or command that
   *  triggered it (e.g. 'follow-link', 'navigator', 'zoom', 'daily-note',
   *  'open-in-panel').
   *  Gesture navigations get it from the intent policy (the surface role);
   *  programmatic callers can set it explicitly. Lets `navigationVerb`
   *  decorators redirect/observe by source, not just by resolved target.
   *  Optional — untagged navigations are still redirectable by target/block. */
  origin?: string
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

/** Input to the navigator / global-command entry points. Deliberately only the
 *  block (and an optional explicit workspace): the target panel is resolved by
 *  the intent policy and `origin` is fixed to `'navigator'`, so neither is
 *  accepted here (a `Pick`, not the full base, so a dropped field is a type
 *  error rather than a silent no-op). */
export type GlobalCommandNavigateInput = Pick<NavigateBaseInput, 'blockId' | 'workspaceId'>

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
): Promise<NavigationResult | null> => {
  // Guard against a stale `panelId` (e.g. a plugin policy resolved to a panel
  // that no longer exists) and mark it active — but only when the layout
  // session is reachable. The content swap below must NOT be coupled to this
  // bookkeeping: if the session can't be resolved we still navigate (the panel
  // block is directly addressable), preserving the long-standing resilience
  // that a bookkeeping failure can't swallow the user-visible navigation.
  try {
    const layoutSessionBlock = await resolveLayoutSessionBlock(repo, workspaceId)
    const panelRows = await panelRowsForLayoutSession(layoutSessionBlock)
    if (!panelRows.some(row => row.id === panelId)) {
      console.warn(`[navigation] ignoring navigation to unknown panel ${panelId}`)
      return null
    }
    await setActivePanel(layoutSessionBlock, panelId)
  } catch (error) {
    console.error('[navigation] Failed to mark panel active after navigation', error)
  }
  await navigateInPanel(repo.block(panelId), blockId)
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
 * The navigation EXECUTION seam. Plugins contribute:
 *   - `navigationVerb.before/after` — observe navigations (history, analytics);
 *     `after` gets the request + the `NavigationResult | null` it resolved to.
 *     (An observer must not unconditionally call `navigate()` itself — it would
 *     re-enter the verb and loop.)
 *   - `navigationVerb.impl` — replace navigation wholesale (`req => myNav(req)`).
 *   - `navigationVerb.decorator` — wrap it: rewrite the intent (call `next` with
 *     a changed `input` — e.g. redirect by `input.origin` / `input.target` /
 *     the target block's type) or veto it (return `null` without calling
 *     `next`).
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
 *  vetoed, no workspace, or it failed). Runs the (already-resolved) intent
 *  through `navigationVerb`, then the default impl applies it. **Never rejects**
 *  — errors are logged and become `null` — so the many fire-and-forget callers
 *  can ignore the returned promise safely. The verb runs when a workspace
 *  resolves and a facet runtime is installed (always in production); the
 *  early-boot / minimal-harness path applies the default directly. */
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

// ---------------------------------------------------------------------------
// Intent layer: gesture → NavigateInput (the navigation POLICY).
// ---------------------------------------------------------------------------

export interface BlockLinkClickModifierState {
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  button: number
}

/** The raw modifier→target matrix. Shared by the default navigation policy and
 *  by surfaces (e.g. quick-find) that map the same gesture onto their own
 *  target vocabulary.
 *    - shift+alt+primary  → new side panel
 *    - shift+primary      → Roam-style vertical sidebar stack
 *    - alt+primary        → main panel
 *    - plain primary      → role decides (see `defaultNavigationIntent`)
 *    - cmd / ctrl / non-primary → `'native'`: let the browser handle the href
 *      (new tab, middle-click) */
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

/** What a plain (no-modifier) primary click should do — also the surface's
 *  navigation *role*, used as the default `origin` of the resulting navigation.
 *  Shift / alt always follow the canonical matrix regardless of this.
 *  - `'follow-link'` (default): navigate the panel the click came from —
 *    `{target: 'panel'}` when inside a panel, `{target: 'active'}` otherwise.
 *    Matches `<a>` and inline-block-link semantics.
 *  - `'navigator'`: open in the global-command target (main on desktop, active
 *    on mobile). Use for command-bar–style UIs whose job is "go to this thing"
 *    regardless of where the click came from — quick find, daily-note picker,
 *    recents button, left-sidebar shortcuts, filter config gear icons, map
 *    "Open" buttons. */
export type BlockOpenerPlainClick = 'follow-link' | 'navigator'

/** A surface's semantic role in navigation. Today this is exactly the
 *  plain-click policy. */
export type NavigationRole = BlockOpenerPlainClick

export type NavigationViewport = 'mobile' | 'desktop'

/** A normalized navigation gesture: everything the intent policy needs to
 *  resolve a `NavigateInput`, with no DOM/window access so the policy stays
 *  pure and testable. Built from a `MouseEvent` (`useBlockOpener`) or
 *  synthesized for a command (`navigateFromGlobalCommand`). */
export interface NavigationGesture {
  role: NavigationRole
  modifiers: BlockLinkClickModifierState
  /** The panel the gesture came from, if any (follow-link uses it as the
   *  navigation target; modifier opens use it as the insertion anchor). */
  panelId?: string
  blockId: string
  workspaceId: string
  viewport: NavigationViewport
}

const PLAIN_PRIMARY_CLICK: BlockLinkClickModifierState = {
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  button: 0,
}

export const modifiersFromMouseEvent = (e: MouseEvent): BlockLinkClickModifierState => ({
  shiftKey: e.shiftKey,
  altKey: e.altKey,
  metaKey: e.metaKey,
  ctrlKey: e.ctrlKey,
  button: e.button,
})

const currentViewport = (): NavigationViewport => (isMobileViewport() ? 'mobile' : 'desktop')

/** The default navigation policy: pure, synchronous, reproducing the canonical
 *  modifier matrix + follow-link/navigator role + viewport rule. Returns the
 *  `NavigateInput` to execute, or `null` for a native passthrough (cmd / ctrl /
 *  middle-click → let the browser handle the href). The resolved input carries
 *  `origin: role` so execution-layer decorators can tell follow-link clicks
 *  from navigator commands. Composable: a plugin policy can call this and tweak
 *  the result. */
export const defaultNavigationIntent = (
  gesture: NavigationGesture,
): NavigateInput | null => {
  const {role, modifiers, panelId, blockId, workspaceId, viewport} = gesture
  const base = {blockId, workspaceId, origin: role}
  switch (blockLinkClickIntent(modifiers)) {
    case 'native':
      return null
    case 'new-panel':
      return {...base, target: 'new-panel', sourcePanelId: panelId}
    case 'sidebar-stack':
      return {...base, target: 'sidebar-stack', sourcePanelId: panelId}
    case 'main':
      return {...base, target: 'main'}
    case 'default':
      if (role === 'navigator') {
        return {...base, target: viewport === 'mobile' ? 'active' : 'main'}
      }
      return panelId
        ? {...base, target: 'panel', panelId}
        : {...base, target: 'active'}
  }
}

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string'

const isNavigateInput = (value: unknown): value is NavigateInput => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  // Untyped dynamic plugins can return anything; validate the fields the
  // dispatch/execution layer actually reads, so e.g. a numeric sourcePanelId
  // can't slip through to `insertPanelRow`.
  if (typeof v.blockId !== 'string') return false
  if (!isOptionalString(v.workspaceId) || !isOptionalString(v.origin)) return false
  switch (v.target) {
    case 'main':
    case 'active':
      return true
    case 'new-panel':
    case 'sidebar-stack':
      return isOptionalString(v.sourcePanelId)
    case 'panel':
      return typeof v.panelId === 'string'
    default:
      return false
  }
}

/**
 * The navigation INTENT seam (policy). Plugins contribute to remap the
 * gesture→target mapping:
 *   - `navigationIntentVerb.impl` — replace resolution wholesale.
 *   - `navigationIntentVerb.decorator` — wrap it: remap the modifier matrix,
 *     override the follow-link/navigator role, or redirect where global
 *     commands land (the original motivating example: active vs main) by
 *     calling `next(gesture)` and tweaking the returned `NavigateInput`.
 *   - `navigationIntentVerb.before/after` — observe gestures.
 * Pure verb on `onError: 'fallback'`: a throwing/invalid plugin policy falls
 * back to `defaultNavigationIntent`, so one buggy policy can't break navigation.
 * The resolved `NavigateInput | null` is handed to `navigate()` (execution).
 */
export const navigationIntentVerb = defineVerbFacet<NavigationGesture, NavigateInput | null>({
  id: 'core.navigation-intent',
  defaultImpl: defaultNavigationIntent,
  onError: 'fallback',
  validateResult: result => result === null || isNavigateInput(result),
})

const resolveNavigationIntent = (
  repo: Repo,
  gesture: NavigationGesture,
): Promise<NavigateInput | null> | NavigateInput | null => {
  const runtime = repo.facetRuntime
  return runtime
    ? navigationIntentVerb.run(runtime, gesture)
    : defaultNavigationIntent(gesture)
}

/** Resolve a gesture through the intent policy, then execute it. The single
 *  path from "user/command gesture" to a navigation; returns where it landed
 *  (or `null` if the policy produced a no-op / the navigation was vetoed).
 *  **Never rejects** — a resolution failure falls back to the default policy
 *  (the intent verb's `onError: 'fallback'` already covers plugin throws; this
 *  guards the verb machinery itself), and execution inherits `navigate`'s
 *  catch-and-log — so the fire-and-forget click handlers are safe. */
export const navigateFromGesture = async (
  repo: Repo,
  gesture: NavigationGesture,
): Promise<NavigationResult | null> => {
  let input: NavigateInput | null
  try {
    input = await resolveNavigationIntent(repo, gesture)
  } catch (error) {
    console.error('[navigation] intent resolution failed', error)
    input = defaultNavigationIntent(gesture)
  }
  if (!input) return null
  return navigate(repo, input)
}

/** Navigate from a global command (command palette, shortcut, navigator-role
 *  click that resolved its block): a plain navigator gesture, so the default
 *  policy lands it in the main panel on desktop / the active panel on mobile.
 *  Routed through the intent policy, so a plugin redirects where global
 *  commands land by decorating `navigationIntentVerb` for `role: 'navigator'`.
 *  origin defaults to `'navigator'`. */
export const navigateFromGlobalCommand = (
  repo: Repo,
  {blockId, workspaceId}: GlobalCommandNavigateInput,
): Promise<NavigationResult | null> => {
  const resolvedWorkspaceId = workspaceId ?? repo.activeWorkspaceId
  if (!resolvedWorkspaceId) return Promise.resolve(null)
  return navigateFromGesture(repo, {
    role: 'navigator',
    modifiers: PLAIN_PRIMARY_CLICK,
    blockId,
    workspaceId: resolvedWorkspaceId,
    viewport: currentViewport(),
  })
}

export const useNavigateFromGlobalCommand = () => {
  const repo = useRepo()
  return useCallback(
    (input: GlobalCommandNavigateInput) => navigateFromGlobalCommand(repo, input),
    [repo],
  )
}

/** The probe gesture the *read* path uses to ask the intent policy "which panel
 *  does a navigator command target right now?" — the navigator target is
 *  block-independent in the default policy (and any sane override), so the
 *  blockId is a neutral placeholder; only the resolved `target` is read.
 *  Expressing a query as a fake gesture is a known smell — tracked in #242 for a
 *  first-class block-free "navigator target" query if a block-dependent
 *  navigator policy ever becomes a real use case. */
const NAVIGATOR_TARGET_PROBE_BLOCK_ID = ''

/** Resolve the live panel a navigator global command currently targets, routed
 *  through the SAME intent policy as the write (`navigateFromGlobalCommand`), so
 *  a plugin that redirects where global commands land (active vs main) feeds the
 *  read too. Returns null when there's no such panel, or the policy targets a
 *  freshly-created panel (new-panel / sidebar-stack — no existing panel to
 *  anchor a read on). */
const resolveGlobalCommandTargetPanel = async (
  repo: Repo,
  workspaceId: string,
) => {
  const input = await resolveNavigationIntent(repo, {
    role: 'navigator',
    modifiers: PLAIN_PRIMARY_CLICK,
    blockId: NAVIGATOR_TARGET_PROBE_BLOCK_ID,
    workspaceId,
    viewport: currentViewport(),
  })
  if (!input) return null
  const layoutSessionBlock = await resolveLayoutSessionBlock(repo, workspaceId)
  switch (input.target) {
    case 'active':
      return resolveActivePanelRow(layoutSessionBlock)
    case 'panel': {
      const rows = await panelRowsForLayoutSession(layoutSessionBlock)
      return rows.find(row => row.id === input.panelId) ?? null
    }
    case 'main':
      return (await panelRowsForLayoutSession(layoutSessionBlock))[0] ?? null
    case 'new-panel':
    case 'sidebar-stack':
      return null
  }
}

/** The top-level block currently shown in the panel a navigator global command
 *  targets — the anchor for read-then-navigate flows (e.g. daily-notes
 *  prev/next day). Goes through the same policy as the navigation, so the anchor
 *  and the destination agree even when a plugin redirects global commands. */
export const resolveGlobalCommandTopLevelBlockId = async (
  repo: Repo,
  workspaceId = repo.activeWorkspaceId,
): Promise<string | null> => {
  if (!workspaceId) return null
  const panel = await resolveGlobalCommandTargetPanel(repo, workspaceId)
  return panel ? panelBlockId(panel) ?? null : null
}

export interface OpenBlockContext {
  blockId: string
  /** Defaults to repo.activeWorkspaceId. */
  workspaceId?: string
}

export interface BlockOpenerOptions {
  plainClick?: BlockOpenerPlainClick
}

/** The standard way for plugins and components to wire a clickable surface
 *  that opens a block — links, buttons, map pins, calendar cells, anything.
 *  Returns a modifier-aware onClick handler that resolves the gesture through
 *  `navigationIntentVerb` (so the policy is plugin-customizable) and executes
 *  the result.
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
  const repo = useRepo()
  const {panelId} = useBlockContext()
  return useCallback(
    (e: MouseEvent, {blockId, workspaceId}: OpenBlockContext) => {
      const resolvedWorkspaceId = workspaceId ?? repo.activeWorkspaceId
      if (!resolvedWorkspaceId) return
      const modifiers = modifiersFromMouseEvent(e)
      // Native passthrough (cmd / ctrl / middle-click) must be decided
      // synchronously so the browser default (new tab) isn't prevented; the
      // rest of the policy resolves async through the intent verb. This carve-
      // out is intentionally NOT plugin-overridable — a plugin shouldn't be
      // able to silently break "cmd-click opens a new tab". (Conversely, since
      // we preventDefault here before the async policy runs, a policy that
      // vetoes a non-native gesture — resolves to null — suppresses the href
      // and the click no-ops; that's the intended meaning of a veto.)
      if (blockLinkClickIntent(modifiers) === 'native') return
      e.stopPropagation()
      e.preventDefault()
      void navigateFromGesture(repo, {
        role: plainClick,
        modifiers,
        panelId,
        blockId,
        workspaceId: resolvedWorkspaceId,
        viewport: currentViewport(),
      })
    },
    [repo, panelId, plainClick],
  )
}
