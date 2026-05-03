import { defineFacet } from '@/extensions/facet.ts'
import type { FacetRuntime } from '@/extensions/facet.ts'
import type { Repo } from '@/data/internals/repo'
import { ActionConfig, ActionContextConfig, ActionContextType } from '@/shortcuts/types.ts'
import { BlockRenderer, RendererRegistry } from '@/types.ts'

export interface AppEffectContext {
  repo: Repo
  runtime: FacetRuntime
  workspaceId: string
  safeMode: boolean
}

export type AppEffectCleanup = () => void | Promise<void>

export interface AppEffect {
  id: string
  start: (
    context: AppEffectContext,
  ) => void | AppEffectCleanup | Promise<void | AppEffectCleanup>
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
  (value.defaultBinding === undefined || isShortcutBindingInput(value.defaultBinding)) &&
  (value.hideFromCommandPallet === undefined || typeof value.hideFromCommandPallet === 'boolean')

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

export const isAppEffect = (value: unknown): value is AppEffect =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.start === 'function'

export const appEffectsFacet = defineFacet<AppEffect, readonly AppEffect[]>({
  id: 'core.app-effects',
  validate: isAppEffect,
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
