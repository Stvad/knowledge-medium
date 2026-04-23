import { defineFacet } from '@/extensions/facet.ts'
import { ActionConfig, ActionContextType, ActionContextTypes } from '@/shortcuts/types.ts'
import { BlockRenderer, RendererRegistry } from '@/types.ts'

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

const actionContextValues = Object.values(ActionContextTypes) as ActionContextType[]

const isActionContextType = (value: unknown): value is ActionContextType =>
  typeof value === 'string' && actionContextValues.includes(value as ActionContextType)

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
