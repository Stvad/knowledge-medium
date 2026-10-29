import type { BlockRendererProps, RendererRegistry } from '../types'
import { rendererProp } from '@/data/properties.js'
import { usePropertyValue, useData } from '@/hooks/block.js'
import { blockRenderersFacet } from '@/extensions/core.js'
import { refreshAppRuntime } from '@/facets/runtimeEvents.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'

export { defaultRegistry } from '@/extensions/defaultRenderers.js'

export const refreshRendererRegistry = async () => {
  refreshAppRuntime()
}

interface ResolveRendererOptions extends BlockRendererProps {
  registry: RendererRegistry
  rendererKey?: string
}

export const resolveRendererFromRegistry = ({
  block,
  context,
  registry,
  rendererKey,
}: ResolveRendererOptions) => {
  if (rendererKey) {
    const requestedRenderer = registry[rendererKey]
    if (requestedRenderer) {
      return requestedRenderer
    }

    const availableRenderers = Object.keys(registry).sort()
    const availableMessage = availableRenderers.length > 0
      ? availableRenderers.join(', ')
      : '(none)'
    console.warn(
      `[useRenderer] renderer "${rendererKey}" is not registered; ` +
      `falling back to renderer predicates. Available renderers: ${availableMessage}`,
    )
  }

  const possibleRenderers = Object.values(registry)
    .filter(renderer => renderer.canRender?.({block, context}))

  const firstPriority = possibleRenderers.sort((a, b) =>
    (b.priority?.({block, context}) || 0) - (a.priority?.({block, context}) || 0))[0]

  return firstPriority ?? registry.default
}

export const useRenderer = ({block, context}: BlockRendererProps) => {
  'use no memo'
  useData(block)
  /**
   * The above is a cludge to make this re-render on useData changes, compiler would over-memoize this otherwise
   * Ideally we make the dependency clear and structural tho
   */

  const [rendererKey] = usePropertyValue(block, rendererProp)
  const runtime = useAppRuntime()
  const registry = runtime.read(blockRenderersFacet)

  /**
   * todo, caching of renderer for each block?
   * maybe do per/type?
   * also allowing people to switch between renderers would be good
   */

  return resolveRendererFromRegistry({block, context, registry, rendererKey})
}
