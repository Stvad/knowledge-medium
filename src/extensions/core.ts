import { defineFacet } from '@/extensions/facet.ts'
import { ActionConfig } from '@/shortcuts/types.ts'
import { BlockRenderer, RendererRegistry } from '@/types.ts'

export interface RendererContribution {
  id: string
  renderer: BlockRenderer
  aliases?: readonly string[]
}

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
})

export const actionsFacet = defineFacet<ActionConfig, readonly ActionConfig[]>({
  id: 'core.actions',
})
