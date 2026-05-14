import { defineFacet } from '@/extensions/facet.ts'
import type { FacetRuntime } from '@/extensions/facet.ts'
import type { Repo } from '../data/repo'
import type { Block } from '../data/block'
import {
  ActionConfig,
  ActionContextConfig,
  ActionContextType,
  type ActionDecorator,
  type ActionOverride,
} from '@/shortcuts/types.ts'
import { BlockRenderer, RendererRegistry } from '@/types.ts'
import type { ComponentType } from 'react'

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

const isActionOverride = (value: unknown): value is ActionOverride =>
  isRecord(value) &&
  typeof value.actionId === 'string' &&
  (value.context === undefined || isActionContextType(value.context)) &&
  typeof value.apply === 'function'

const isActionDecorator = (value: unknown): value is ActionDecorator =>
  isRecord(value) &&
  typeof value.actionId === 'string' &&
  (value.context === undefined || isActionContextType(value.context)) &&
  typeof value.decorate === 'function'

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

export const actionOverridesFacet = defineFacet<ActionOverride, readonly ActionOverride[]>({
  id: 'core.action-overrides',
  validate: isActionOverride,
})

export const actionDecoratorsFacet = defineFacet<ActionDecorator, readonly ActionDecorator[]>({
  id: 'core.action-decorators',
  validate: isActionDecorator,
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

export const appMountsFacet = defineFacet<AppMountContribution, readonly AppMountContribution[]>({
  id: 'core.app-mounts',
  validate: isAppMountContribution,
})

export const isPanelMountContribution = (value: unknown): value is PanelMountContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.component === 'function'

export const panelMountsFacet = defineFacet<PanelMountContribution, readonly PanelMountContribution[]>({
  id: 'core.panel-mounts',
  validate: isPanelMountContribution,
})

const isHeaderItemRegion = (value: unknown): value is HeaderItemRegion =>
  value === 'start' || value === 'end'

export const isHeaderItemContribution = (value: unknown): value is HeaderItemContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  isHeaderItemRegion(value.region) &&
  typeof value.component === 'function'

export const headerItemsFacet = defineFacet<HeaderItemContribution, readonly HeaderItemContribution[]>({
  id: 'core.header-items',
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
