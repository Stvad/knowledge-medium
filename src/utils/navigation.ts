// User-intent navigation, in two layers — each an extension seam:
//
//   1. INTENT POLICY (`navigationIntentVerb`): resolves a *gesture* (a click's
//      role + modifiers, or a global command) into a `NavigationDecision` —
//      `navigate` (which block, which target panel), `passthrough` (let the
//      browser handle the href), or `suppress` (veto, no-op). Pure and
//      **synchronous** — resolved via the verb's `runSync`, so a gesture surface
//      can decide `preventDefault` from the decision before yielding; plugins
//      remap the modifier matrix, override the follow-link/navigator role,
//      redirect where global commands land (active vs main), or flip a gesture
//      between in-app navigation and native passthrough by decorating/replacing it.
//   2. EXECUTION (`navigationVerb`): applies a `NavigateInput` — the layout
//      mutation that shows the block — and returns where it landed. Effectful;
//      plugins observe (before/after), rewrite (by target / origin / block),
//      veto (return `null`), or replace it wholesale.
//
// `navigate(repo, input)` is the execution entry: it runs `navigationVerb` and
// returns the resolved destination. It **never rejects** (errors are logged →
// `null`), so the many fire-and-forget callers can ignore the promise. Gesture
// surfaces resolve a `NavigationDecision` through the intent policy first
// (synchronously — see `resolveNavigationIntent`): a click surface routes the
// decision through `applyNavigationDecision` (the one place that gates
// `preventDefault`), while `navigateFromGlobalCommand` goes through the shared
// `navigateFromGesture` helper — both hand a `navigate` decision's input to
// `navigate`. Every `NavigateInput` can carry an `origin` tag so execution-layer
// decorators can redirect/observe by source, not just by the resolved target —
// gesture navigations get it from the policy (the surface role); programmatic
// callers set it explicitly.
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
import { activePanelIdProp, topLevelBlockIdProp } from '@/data/properties'
import { parseAppHash } from '@/utils/routing'
import { isMobileViewport } from '@/utils/viewport'
import {
  insertPanelRow,
  insertSidebarStackedPanel,
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
  /** Must be an existing **panel** block. The execution guard only checks the
   *  block exists (cache-first, so a live-but-not-yet-projected panel still
   *  passes) — NOT that it's a panel — so passing a non-panel block id would
   *  write panel props onto it. In practice `panelId` always comes from a
   *  rendered panel (`useBlockContext().panelId` / the zoom panel's UiState
   *  block); callers must not pass an arbitrary content block. */
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

/** A `NavigateInput` with the workspace resolved to a concrete id — the form
 *  that flows through the execution pipeline. The workspace is resolved exactly
 *  once, at the entry (`navigate` / `navigateFromGesture`); everything
 *  downstream reads `input.workspaceId` and never re-reads
 *  `repo.activeWorkspaceId`, so an async observer/decorator plus a mid-flight
 *  workspace switch can't change where the navigation lands. A decorator can
 *  still retarget by setting `input.workspaceId`. */
export type ResolvedNavigateInput = NavigateInput & {workspaceId: string}

/** Where a navigation landed: the panel showing the block, the block, and the
 *  workspace it landed in — the resolved result of `navigate()` /
 *  `navigationVerb`, and the source of truth callers should read (rather than
 *  re-deriving from the request they submitted, which a decorator may have
 *  rewritten). */
export interface NavigationResult {
  panelId: string
  blockId: string
  workspaceId: string
}

/** Input to `navigationVerb`: the resolved navigation (workspace already pinned
 *  into `input.workspaceId`) and the live repo — impls/observers need the repo
 *  to inspect the target block, read prefs, or perform a fully custom
 *  navigation. */
export interface NavigationRequest {
  repo: Repo
  input: ResolvedNavigateInput
}

const resolveLayoutSessionBlock = async (repo: Repo, workspaceId: string) => {
  const uiState = await getUIStateBlock(repo, workspaceId, repo.user, {})
  return getLayoutSessionBlock(uiState, getLayoutSessionId())
}

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
  await layoutSessionBlock.repo.query.subtree({id: layoutSessionBlock.id, hidePropertyChildren: true}).load(),
)

const resolveActivePanelRow = async (
  layoutSessionBlock: Block,
) => {
  await layoutSessionBlock.load()
  const panelRows = await panelRowsForLayoutSession(layoutSessionBlock)
  const activePanelId = layoutSessionBlock.peekProperty(activePanelIdProp)
  return panelRows.find(row => row.id === activePanelId) ?? panelRows.at(-1) ?? null
}

/** Where a resolved navigation should go: an existing panel to swap, or a fresh
 *  panel to create. The single decision both the WRITE (`applyNavigation`) and
 *  the READ (`resolveGlobalCommandTarget`) share, so they can't drift — every
 *  target→panel + workspace rule lives here once. `null` = refused (a stale
 *  explicit panelId). */
type NavDestination =
  | {kind: 'panel'; workspaceId: string; panelId: string}
  | {kind: 'create-row'; workspaceId: string; afterPanelId?: string}
  | {kind: 'create-stack'; workspaceId: string; sourcePanelId?: string}
  | null

const resolveDestination = async (
  repo: Repo,
  input: ResolvedNavigateInput,
): Promise<NavDestination> => {
  const {workspaceId} = input
  switch (input.target) {
    case 'new-panel':
      return {kind: 'create-row', workspaceId, afterPanelId: input.sourcePanelId}
    case 'sidebar-stack':
      return {kind: 'create-stack', workspaceId, sourcePanelId: input.sourcePanelId}
    case 'panel':
      // Guard a stale/fabricated panelId via block existence (NOT layout-row
      // membership): `repo.exists` is cache-first and treats soft-deletes as
      // missing, so a live panel always passes — including one not yet in the
      // projected subtree — while a deleted/unknown id is refused, decoupled
      // from the layout projection.
      return (await repo.exists(input.panelId))
        ? {kind: 'panel', workspaceId, panelId: input.panelId}
        : null
    case 'main': {
      const ls = await resolveLayoutSessionBlock(repo, workspaceId)
      const panels = await panelRowsForLayoutSession(ls)
      return panels[0]
        ? {kind: 'panel', workspaceId, panelId: panels[0].id}
        : {kind: 'create-row', workspaceId}
    }
    case 'active': {
      const ls = await resolveLayoutSessionBlock(repo, workspaceId)
      const panel = await resolveActivePanelRow(ls)
      return panel
        ? {kind: 'panel', workspaceId, panelId: panel.id}
        : {kind: 'create-row', workspaceId}
    }
  }
}

/** Apply a resolved navigation by mutating layout-session panel rows, returning
 *  where it landed. `navigationVerb`'s default impl. The "where does this go"
 *  decision is `resolveDestination` (shared with the read path); this is just
 *  the effect. The workspace comes from the resolved input — never a fresh
 *  `repo.activeWorkspaceId` read — so an async observer/decorator can't move the
 *  landing. Active-panel bookkeeping is awaited (so it can't outlive the
 *  navigation and clobber a later one) but failure-isolated and after the swap,
 *  so a layout-session failure can't swallow the already-applied content swap. */
const applyNavigation = async (
  {repo, input}: NavigationRequest,
): Promise<NavigationResult | null> => {
  const dest = await resolveDestination(repo, input)
  if (!dest) return null
  const {workspaceId} = dest
  const {blockId} = input

  switch (dest.kind) {
    case 'panel': {
      // Swap the panel's content first (the primary, user-visible effect), then
      // mark it active. Both are AWAITED as part of THIS navigation: a
      // fire-and-forget active write can outlive `navigate()` and land after a
      // later navigation's active write, leaving the wrong panel active. Marking
      // active is failure-isolated AND comes after the swap, so neither a
      // layout-session failure nor a swap failure can leave a panel marked
      // active without its content actually swapped.
      await navigateInPanel(repo.block(dest.panelId), blockId)
      try {
        const ls = await resolveLayoutSessionBlock(repo, workspaceId)
        await setActivePanel(ls, dest.panelId)
      } catch (error) {
        console.error('[navigation] Failed to mark panel active after navigation', error)
      }
      return {panelId: dest.panelId, blockId, workspaceId}
    }
    case 'create-row': {
      const ls = await resolveLayoutSessionBlock(repo, workspaceId)
      const panelId = await insertPanelRow(repo, ls, blockId, {afterPanelId: dest.afterPanelId})
      return {panelId, blockId, workspaceId}
    }
    case 'create-stack': {
      const ls = await resolveLayoutSessionBlock(repo, workspaceId)
      const panelId = await insertSidebarStackedPanel(repo, ls, blockId, {
        sourcePanelId: dest.sourcePanelId,
      })
      return {panelId, blockId, workspaceId}
    }
  }
}

/**
 * The navigation EXECUTION seam. Plugins contribute:
 *   - `navigationVerb.before/after` — observe navigations (history, analytics);
 *     `after` gets the request + a `VerbOutcome<NavigationResult | null>`
 *     (`{ok: true, result}` on success, `{ok: false, error}` on failure — it
 *     fires for every outcome). (An observer must not unconditionally call
 *     `navigate()` itself — it would re-enter the verb and loop.)
 *   - `navigationVerb.impl` — replace navigation wholesale (`req => myNav(req)`).
 *   - `navigationVerb.decorator` — wrap it: rewrite the intent (call `next` with
 *     a changed `input` — e.g. redirect by `input.origin` / `input.target` /
 *     the target block's type) or veto it (return `null` without calling
 *     `next`). Rewrite by **spreading** the input (`{...req.input, …}`) — the
 *     resolved `input.workspaceId` is required and must be carried; a decorator
 *     that builds a fresh input and drops it fails closed (the result fails
 *     `validateResult` → the navigation no-ops) rather than silently landing in
 *     the wrong workspace. The type enforces this for typed plugins.
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
    return typeof r.panelId === 'string'
      && typeof r.blockId === 'string'
      && typeof r.workspaceId === 'string'
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

  // Pin the workspace into the input ONCE here (the entry boundary) → the
  // pipeline reads `input.workspaceId` and never re-reads `repo.activeWorkspaceId`.
  const request: NavigationRequest = {repo, input: {...input, workspaceId}}
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

const modifiersFromMouseEvent = (e: MouseEvent): BlockLinkClickModifierState => ({
  shiftKey: e.shiftKey,
  altKey: e.altKey,
  metaKey: e.metaKey,
  ctrlKey: e.ctrlKey,
  button: e.button,
})

const currentViewport = (): NavigationViewport => (isMobileViewport() ? 'mobile' : 'desktop')

/** The outcome of resolving a gesture through the intent policy — the three
 *  terminal things a clickable surface can do, as a tagged union so every
 *  consumer discriminates exhaustively (no overloaded `null`/sentinel):
 *    - `navigate`    — go in-app: the surface owns the event and runs `navigate`.
 *    - `passthrough` — decline the event: let the browser act on its native
 *      default (follow the `<a href>` — cmd-click new tab, plain follow). NOT an
 *      in-app navigation; it deliberately does NOT go through `navigate()`
 *      (which is rows→URL and would re-push history / loop — see module header).
 *    - `suppress`    — veto: the surface owns the event and no-ops.
 *  Separating `passthrough` from `suppress` is what makes BOTH directions
 *  plugin-overridable — a policy can turn a cmd-click into an in-app navigation
 *  (`navigate`) or a plain click into a browser passthrough (`passthrough`). */
export type NavigationDecision =
  | {kind: 'navigate'; input: NavigateInput}
  | {kind: 'passthrough'}
  | {kind: 'suppress'}

/** Build a `navigate` decision. */
export const goTo = (input: NavigateInput): NavigationDecision => ({kind: 'navigate', input})
/** Decline the event — let the browser handle the native default (href).
 *  Frozen: it's a shared public-API singleton; a consumer must not mutate it. */
export const PASSTHROUGH: NavigationDecision = Object.freeze({kind: 'passthrough'})
/** Own the event and no-op (veto). Frozen — shared public-API singleton. */
export const SUPPRESS: NavigationDecision = Object.freeze({kind: 'suppress'})

/** Transform only the `navigate` case of a decision, passing `passthrough` /
 *  `suppress` through untouched — the ergonomic way for a plugin decorator to
 *  tweak the resolved `NavigateInput`. `f` returning an explicit `null` is a
 *  veto (→ `SUPPRESS`); ONLY `null`. Any other non-input result (e.g. an untyped
 *  mapper with a missing `return` → `undefined`) is left as an invalid
 *  `navigate` so the verb's `validateResult`/`onError` fall back to the default
 *  policy — rather than silently turning a buggy mapper into a veto. */
export const mapNavigate = (
  decision: NavigationDecision,
  f: (input: NavigateInput) => NavigateInput | null,
): NavigationDecision => {
  if (decision.kind !== 'navigate') return decision
  const next = f(decision.input)
  return next === null ? SUPPRESS : goTo(next)
}

/** The default navigation policy: pure, synchronous, reproducing the canonical
 *  modifier matrix + follow-link/navigator role + viewport rule. Returns a
 *  `navigate` decision (whose input carries `origin: role` so execution-layer
 *  decorators can tell follow-link clicks from navigator commands), or
 *  `PASSTHROUGH` for a native gesture (cmd / ctrl / middle-click → let the
 *  browser handle the href). Composable: a plugin policy can call this and
 *  `mapNavigate` the result. */
export const defaultNavigationIntent = (
  gesture: NavigationGesture,
): NavigationDecision => {
  const {role, modifiers, panelId, blockId, workspaceId, viewport} = gesture
  const base = {blockId, workspaceId, origin: role}
  switch (blockLinkClickIntent(modifiers)) {
    case 'native':
      return PASSTHROUGH
    case 'new-panel':
      return goTo({...base, target: 'new-panel', sourcePanelId: panelId})
    case 'sidebar-stack':
      return goTo({...base, target: 'sidebar-stack', sourcePanelId: panelId})
    case 'main':
      return goTo({...base, target: 'main'})
    case 'default':
      if (role === 'navigator') {
        return goTo({...base, target: viewport === 'mobile' ? 'active' : 'main'})
      }
      return goTo(panelId
        ? {...base, target: 'panel', panelId}
        : {...base, target: 'active'})
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

const isNavigationDecision = (value: unknown): value is NavigationDecision => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as {kind?: unknown; input?: unknown}
  switch (v.kind) {
    case 'passthrough':
    case 'suppress':
      return true
    case 'navigate':
      return isNavigateInput(v.input)
    default:
      return false
  }
}

/**
 * The navigation INTENT seam (policy). Plugins contribute to remap the
 * gesture→target mapping, returning a `NavigationDecision`:
 *   - `navigationIntentVerb.impl` — replace resolution wholesale.
 *   - `navigationIntentVerb.decorator` — wrap it: remap the modifier matrix,
 *     override the follow-link/navigator role, redirect where global commands
 *     land (active vs main), or flip a gesture between in-app navigation and
 *     native passthrough — call `next(gesture)` and reshape via `mapNavigate`
 *     (tweak the input) or by returning `PASSTHROUGH` / `SUPPRESS` / `goTo(…)`.
 *   - `navigationIntentVerb.before/after` — observe gestures.
 * Pure verb on `onError: 'fallback'`: a throwing/invalid plugin policy falls
 * back to `defaultNavigationIntent`, so one buggy policy can't break navigation.
 * Resolved with `runSync` (the policy is pure, no I/O) so gesture surfaces can
 * gate `preventDefault` on the result — so contributions must be **synchronous**;
 * an `impl`/`decorator` that returns a promise violates the contract and falls
 * back to `defaultNavigationIntent` (async before/after observers are fine —
 * they're fire-and-forget). The resolved `NavigationDecision` is routed by the
 * surface (`applyNavigationDecision` for clicks) or, for navigate, by `navigate()`.
 */
export const navigationIntentVerb = defineVerbFacet<NavigationGesture, NavigationDecision>({
  id: 'core.navigation-intent',
  defaultImpl: defaultNavigationIntent,
  onError: 'fallback',
  validateResult: isNavigationDecision,
})

/** Resolve a gesture into a `NavigationDecision` through the intent policy,
 *  **synchronously** — so a gesture surface can gate `preventDefault` on the
 *  result before yielding. **Never throws**: `runSync` already falls back to
 *  `defaultNavigationIntent` for a buggy plugin policy (`onError: 'fallback'`);
 *  the try/catch here guards the verb machinery itself. The early-boot /
 *  minimal-harness path (no runtime) applies the default policy directly.
 *
 *  Carries the gesture's captured workspace into a `navigate` decision that
 *  omitted one (a plugin policy may), so it lands in the workspace the gesture
 *  originated in — even if a policy mutated the active workspace synchronously
 *  during resolution. Centralized here so every consumer (clicks + commands)
 *  inherits it; a policy that sets `workspaceId` wins. */
const resolveNavigationIntent = (
  repo: Repo,
  gesture: NavigationGesture,
): NavigationDecision => {
  const runtime = repo.facetRuntime
  let decision: NavigationDecision
  if (!runtime) {
    decision = defaultNavigationIntent(gesture)
  } else {
    try {
      decision = navigationIntentVerb.runSync(runtime, gesture)
    } catch (error) {
      console.error('[navigation] intent resolution failed', error)
      decision = defaultNavigationIntent(gesture)
    }
  }
  return decision.kind === 'navigate' && !decision.input.workspaceId
    ? goTo({...decision.input, workspaceId: gesture.workspaceId})
    : decision
}

/** Apply a resolved decision to the click that produced it — the single place
 *  that maps an intent outcome onto DOM event handling, so no clickable surface
 *  re-implements the native-vs-veto distinction:
 *    - `passthrough` → decline the event; the browser follows the href.
 *    - `navigate` / `suppress` → own the event (`stopPropagation` +
 *      `preventDefault`); `navigate` then fires the in-app navigation,
 *      `suppress` is a veto no-op. */
export const applyNavigationDecision = (
  repo: Repo,
  e: MouseEvent,
  decision: NavigationDecision,
): void => {
  if (decision.kind === 'passthrough') return
  e.stopPropagation()
  e.preventDefault()
  if (decision.kind === 'navigate') void navigate(repo, decision.input)
}

/** Resolve a gesture through the intent policy, then execute it. The single
 *  path from "user/command gesture" to a navigation; returns where it landed
 *  (or `null` if the policy produced a no-op / the navigation was vetoed).
 *  **Never rejects** — resolution falls back to the default policy (see
 *  `resolveNavigationIntent`) and execution inherits `navigate`'s
 *  catch-and-log — so the fire-and-forget click handlers are safe. */
export const navigateFromGesture = async (
  repo: Repo,
  gesture: NavigationGesture,
): Promise<NavigationResult | null> => {
  // Command surfaces have no DOM event to gate, so only the `navigate` decision
  // does anything here; `passthrough` / `suppress` resolve to no navigation.
  // (`resolveNavigationIntent` has already carried the gesture workspace.)
  const decision = resolveNavigationIntent(repo, gesture)
  return decision.kind === 'navigate' ? navigate(repo, decision.input) : null
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

/** Where a navigator global command currently anchors: the block shown in the
 *  panel it targets, AND the workspace that panel lives in. The anchor for
 *  read-then-navigate flows (e.g. daily-notes prev/next day). Routed through the
 *  SAME policy + `resolveDestination` as the write, so the anchor and the
 *  eventual navigation agree even when a policy retargets the panel (active vs
 *  main) or the workspace — and it returns the resolved `workspaceId` so callers
 *  validate/create against the workspace the block actually lives in, not the
 *  one they passed in. `null` when there's no existing panel to anchor on (the
 *  target would create a fresh panel) or no workspace. */
export const resolveGlobalCommandTarget = async (
  repo: Repo,
  workspaceId = repo.activeWorkspaceId,
): Promise<{blockId: string; workspaceId: string} | null> => {
  if (!workspaceId) return null
  const decision = resolveNavigationIntent(repo, {
    role: 'navigator',
    modifiers: PLAIN_PRIMARY_CLICK,
    blockId: NAVIGATOR_TARGET_PROBE_BLOCK_ID,
    workspaceId,
    viewport: currentViewport(),
  })
  // Only an in-app navigation has a panel to anchor on; passthrough/suppress don't.
  if (decision.kind !== 'navigate') return null
  // Honor a policy-retargeted workspace; fall back to the probe workspace.
  const resolved: ResolvedNavigateInput = {...decision.input, workspaceId: decision.input.workspaceId ?? workspaceId}
  const dest = await resolveDestination(repo, resolved)
  // Only an existing-panel destination has a current block to anchor on;
  // create-row/create-stack would open a fresh panel.
  if (dest?.kind !== 'panel') return null
  await repo.load(dest.panelId)
  const blockId = repo.block(dest.panelId).peekProperty(topLevelBlockIdProp)
  return typeof blockId === 'string' ? {blockId, workspaceId: dest.workspaceId} : null
}

/** The active workspace, preferring the URL hash over `repo.activeWorkspaceId`.
 *  The hash is the source of truth for what workspace the user is VIEWING;
 *  `repo.activeWorkspaceId` can lag behind it during async bootstrap (the
 *  active id flips inside App.tsx's `getInitialBlock` chain, which awaits a
 *  workspace lookup + role check before settling) or shortly after a
 *  workspace switch. A command fired in that window would otherwise route
 *  into the prior workspace. Falls back to `repo.activeWorkspaceId` once the
 *  hash carries no workspace of its own (e.g. very first boot). (Originally
 *  identified in the roam-import action; hoisted here once the same
 *  read-hash-first-then-repo idiom showed up at several call sites.) */
export const activeWorkspaceIdPreferringHash = (repo: Repo): string | null =>
  parseAppHash(window.location.hash).workspaceId ?? repo.activeWorkspaceId

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

/** The opener-click logic behind `useBlockOpener`/`useOpenBlock`, factored out
 *  of the hook so it's exercisable without a React render: build the gesture
 *  from the event, resolve the full plugin-customized decision SYNCHRONOUSLY,
 *  then let the single applier route it — `passthrough` lets the browser handle
 *  the href (cmd-click new tab, …); `navigate`/`suppress` means we own the click.
 *  Because the native-vs-veto distinction is the policy's `NavigationDecision`
 *  (not a hardcoded pre-check), native passthrough is plugin-overridable: a
 *  policy can turn a cmd-click into an in-app navigation, or a plain click into
 *  a passthrough. No-ops when no workspace can be resolved. */
export const openBlockFromEvent = (
  repo: Repo,
  e: MouseEvent,
  {blockId, workspaceId}: OpenBlockContext,
  {plainClick = 'follow-link', panelId}: {plainClick?: BlockOpenerPlainClick; panelId?: string} = {},
): void => {
  const resolvedWorkspaceId = workspaceId ?? repo.activeWorkspaceId
  if (!resolvedWorkspaceId) return
  applyNavigationDecision(repo, e, resolveNavigationIntent(repo, {
    role: plainClick,
    modifiers: modifiersFromMouseEvent(e),
    panelId,
    blockId,
    workspaceId: resolvedWorkspaceId,
    viewport: currentViewport(),
  }))
}

/** Returns an opener `(event, {blockId, workspaceId?}) => void` for places
 *  that resolve the target block from the event (lists, breadcrumbs, map
 *  markers rendered in a loop). Single subscription per component instead
 *  of one hook per item. */
export const useBlockOpener = ({plainClick = 'follow-link'}: BlockOpenerOptions = {}) => {
  const repo = useRepo()
  const {panelId} = useBlockContext()
  return useCallback(
    (e: MouseEvent, target: OpenBlockContext) =>
      openBlockFromEvent(repo, e, target, {plainClick, panelId}),
    [repo, panelId, plainClick],
  )
}
