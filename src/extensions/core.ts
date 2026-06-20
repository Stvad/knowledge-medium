import { dedupById, defineFacet, keyedMapFacet } from '@/facets/facet.js'
import type { FacetRuntime } from '@/facets/facet.js'
import type { Repo } from '../data/repo'
import type { Block } from '../data/block'
import type { ProcessorRejection } from '@/data/api'
import {
  ActionConfig,
  ActionContextConfig,
  ActionContextType,
  type ActionTransform,
} from '@/shortcuts/types.js'
import { BlockRenderer, RendererRegistry } from '@/types.js'
import type { ComponentType, ReactElement } from 'react'

export interface AppEffectContext {
  repo: Repo
  runtime: FacetRuntime
  workspaceId: string
  safeMode: boolean
}

/** Context passed to `workspaceLandingFacet` resolvers when the app
 *  boots into an empty layout (no panels in the URL hash). The
 *  resolver decides what block the user lands on — e.g. today's daily
 *  note. `freshlyCreated` is true on the very first run for a brand-
 *  new personal workspace; resolvers use it to seed first-run
 *  affordances (a [[Tutorial]] bullet etc.).
 *
 *  Runs BEFORE React mounts (inside App.tsx's bootstrap chain), so
 *  resolvers cannot use hooks or read the live `FacetRuntime`. Talk
 *  to the Repo directly. */
export interface WorkspaceLandingContext {
  repo: Repo
  workspaceId: string
  freshlyCreated: boolean
}

/** A landing resolver returns the block id to open, or null to defer
 *  to lower-precedence resolvers. The first resolver (in precedence
 *  order, highest first) that returns a non-null id wins.
 *
 *  The resolver is responsible for any side-effects needed to make
 *  that block exist (e.g. `getOrCreateDailyNote` calls a tx that
 *  inserts the row). Returning a block id whose row doesn't exist is
 *  a bug: the caller will navigate to it and break. */
export type WorkspaceLandingResolver = (
  ctx: WorkspaceLandingContext,
) => Promise<string | null>

export type AppEffectCleanup = () => void | Promise<void>

/**
 * A long-lived side-effect (subscription, interval, window listener, the
 * agent-runtime bridge) tied to the extension lifecycle. `start` runs once
 * when the effect first appears and returns an optional cleanup.
 *
 * Lifecycle contract — the reconciler restarts (cleanup + re-`start`) an
 * effect only when:
 *   1. `repo` / `workspaceId` / `safeMode` change (values `start` captures
 *      directly, not through the runtime), or
 *   2. the effect's *contribution object identity* changes — i.e. a
 *      different `AppEffect` reference is registered under the same `id`.
 *
 * Otherwise the effect keeps running across runtime swaps (extension
 * toggles, dynamic-plugin loads); the `runtime` it received is a live
 * handle that re-points itself at the fresh runtime, so `read` /
 * `onFacetChange` / `setRuntimeContributions` stay valid without a restart.
 *
 * This means the AppEffect object MUST be a stable reference across
 * resolves unless its code actually changed. Build it once at module scope
 * (or memoize it); do NOT construct `{id, start}` inline inside a
 * function-valued extension, and for dynamic extensions export an array,
 * not a function — a fresh object every resolve reads as "identity
 * changed" and silently restarts the effect on every unrelated swap.
 * Duplicate `id`s are last-wins with a warn (per the facet convention).
 * Cleanup must be idempotent and fast.
 */
export interface AppEffect {
  id: string
  start: (
    context: AppEffectContext,
  ) => void | AppEffectCleanup | Promise<void | AppEffectCleanup>
}

export interface AppMountContribution {
  id: string
  component: ComponentType
}

/** Per-panel mount point — components contributed via `panelMountsFacet`
 *  render once inside each `<PanelRenderer/>`'s root, with the panel's
 *  UI-state block passed as `block`. Use this for chrome that needs to
 *  live in panel scope (independent menu state per panel, panel-scoped
 *  DOM lookups, etc.) instead of the global `appMountsFacet` (one
 *  instance app-wide, no panel context).
 *
 *  Components are mounted as siblings to the panel's scrollable
 *  content, inside `.panel`, so they sit in the same positioning
 *  context as the panel's body. */
export interface PanelMountContribution {
  id: string
  component: ComponentType<{block: Block}>
}

export type HeaderItemRegion = 'start' | 'end'

export interface HeaderItemContribution {
  id: string
  region: HeaderItemRegion
  component: ComponentType
}

export interface RendererContribution {
  id: string
  renderer: BlockRenderer
  aliases?: readonly string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

export const isRendererContribution = (value: unknown): value is RendererContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.renderer === 'function' &&
  (value.aliases === undefined || isStringArray(value.aliases))

const isActionContextType = (value: unknown): value is ActionContextType =>
  typeof value === 'string' && value.length > 0

const isShortcutKeys = (value: unknown): value is string | string[] =>
  typeof value === 'string' || isStringArray(value)

const isShortcutBindingInput = (value: unknown): value is NonNullable<ActionConfig['defaultBinding']> =>
  isRecord(value) &&
  isShortcutKeys(value.keys) &&
  (value.eventOptions === undefined || isRecord(value.eventOptions))

export const isActionConfig = (value: unknown): value is ActionConfig =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.description === 'string' &&
  isActionContextType(value.context) &&
  typeof value.handler === 'function' &&
  (value.defaultBinding === undefined || isShortcutBindingInput(value.defaultBinding))

const isActionTransform = (value: unknown): value is ActionTransform =>
  isRecord(value) &&
  typeof value.actionId === 'string' &&
  (value.context === undefined || isActionContextType(value.context)) &&
  typeof value.apply === 'function'

export const createRendererRegistry = (
  contributions: readonly RendererContribution[],
): RendererRegistry => {
  const registry: RendererRegistry = {}

  for (const contribution of contributions) {
    registry[contribution.id] = contribution.renderer
    for (const alias of contribution.aliases ?? []) {
      registry[alias] = contribution.renderer
    }
  }

  return registry
}

export const blockRenderersFacet = defineFacet<RendererContribution, RendererRegistry>({
  id: 'core.block-renderers',
  combine: createRendererRegistry,
  empty: () => ({}),
  validate: isRendererContribution,
})

export const actionsFacet = defineFacet<ActionConfig, readonly ActionConfig[]>({
  id: 'core.actions',
  validate: isActionConfig,
})

/**
 * The one facet for contributing action transforms (replace / wrap /
 * unbind). The effective-actions pipeline runs every contribution in a
 * single ordered pass.
 */
export const actionTransformsFacet = defineFacet<ActionTransform, readonly ActionTransform[]>({
  id: 'core.action-transforms',
  validate: isActionTransform,
})

export const isAppEffect = (value: unknown): value is AppEffect =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.start === 'function'

export const appEffectsFacet = defineFacet<AppEffect, readonly AppEffect[]>({
  id: 'core.app-effects',
  validate: isAppEffect,
})

export const isAppMountContribution = (value: unknown): value is AppMountContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.component === 'function'

// Dedup by logical `id` (last-wins) rather than the default keep-all: an
// app mount is rendered once per contribution keyed by `id` (see
// `AppMounts` in AppRuntimeProvider), and mounts are minted fresh inside
// plugin factories, so resolver identity dedup can't catch a logical
// duplicate — two same-id contributions would otherwise double-mount
// (#64). See `dedupById` for the tie-break rationale.
export const appMountsFacet = defineFacet<AppMountContribution, readonly AppMountContribution[]>({
  id: 'core.app-mounts',
  combine: dedupById('core.app-mounts'),
  validate: isAppMountContribution,
})

/** A plugin's toast for a `ProcessorRejection` code it emits. The plugin
 *  owns the body (copy, actions); core owns the imperative envelope
 *  (`showCustom`, duration) and the unknown-code fallback — see
 *  `extensions/processorRejectionToast`. Keyed by `code` (last-wins). */
export interface RejectionToastContribution {
  /** `ProcessorRejection.code` this renderer handles. */
  code: string
  /** Toast body for `error`. `toastId` lets the body dismiss itself;
   *  `repo` lets action buttons dispatch. Returning an element for
   *  malformed meta (rather than throwing) keeps a can't-happen case
   *  visible. */
  render: (error: ProcessorRejection, repo: Repo, toastId: string | number) => ReactElement
}

export const rejectionToastFacet = keyedMapFacet<RejectionToastContribution>(
  'core.rejection-toasts',
  c => c.code,
)

export const isPanelMountContribution = (value: unknown): value is PanelMountContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.component === 'function'

// Per-panel render mount keyed by `id` — same double-mount hazard as
// `appMountsFacet`, so dedup by id (last-wins).
export const panelMountsFacet = defineFacet<PanelMountContribution, readonly PanelMountContribution[]>({
  id: 'core.panel-mounts',
  combine: dedupById('core.panel-mounts'),
  validate: isPanelMountContribution,
})

const isHeaderItemRegion = (value: unknown): value is HeaderItemRegion =>
  value === 'start' || value === 'end'

export const isHeaderItemContribution = (value: unknown): value is HeaderItemContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  isHeaderItemRegion(value.region) &&
  typeof value.component === 'function'

// Header items render once per contribution keyed by `id` (see Header.tsx)
// — dedup by id (last-wins) so a logical duplicate can't render twice.
export const headerItemsFacet = defineFacet<HeaderItemContribution, readonly HeaderItemContribution[]>({
  id: 'core.header-items',
  combine: dedupById('core.header-items'),
  validate: isHeaderItemContribution,
})

export const isActionContextConfig = (value: unknown): value is ActionContextConfig =>
  isRecord(value) &&
  isActionContextType(value.type) &&
  typeof value.displayName === 'string' &&
  (value.defaultEventOptions === undefined || isRecord(value.defaultEventOptions)) &&
  (value.eventFilter === undefined || typeof value.eventFilter === 'function') &&
  typeof value.validateDependencies === 'function'

export const actionContextsFacet = defineFacet<ActionContextConfig, readonly ActionContextConfig[]>({
  id: 'core.action-contexts',
  validate: isActionContextConfig,
})

/** Plugins contribute landing resolvers; App.tsx tries them in order
 *  on bootstrap-with-empty-layout and uses the first non-null result.
 *  `FacetRuntime` sorts contributions ascending by `precedence`
 *  (default 0) before passing them here, so the highest-precedence
 *  resolver ends up LAST in the returned array; App.tsx walks the
 *  array in reverse so high-precedence wins. Without contributions the
 *  bootstrap leaves the layout empty — the panel projection then
 *  renders an empty panel stack, which is the historical fallback. */
export const workspaceLandingFacet = defineFacet<WorkspaceLandingResolver, readonly WorkspaceLandingResolver[]>({
  id: 'core.workspace-landing',
  validate: (value): value is WorkspaceLandingResolver => typeof value === 'function',
})
