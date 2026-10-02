import { BlockRendererProps } from '../types'
import { rendererProp } from '@/data/properties.js'
import { usePropertyValue, useData } from '@/hooks/block.js'
import { blockRenderersFacet } from '@/extensions/core.js'
import { refreshAppRuntime } from '@/facets/runtimeEvents.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'

export { defaultRegistry } from '@/extensions/defaultRenderers.js'

export const refreshRendererRegistry = async () => {
  refreshAppRuntime()
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

  if (rendererKey) {
    if (registry[rendererKey]) {
      return registry[rendererKey]
    }
    // Explicit override was set but is missing (typo, plugin not loaded, rename).
    // Fall through to canRender resolution, but surface the lost override.
    const available = Object.keys(registry)
    console.warn(
      `[useRenderer] renderer id ${JSON.stringify(rendererKey)} is not registered; ` +
        `falling back to canRender resolution. Available ids: ${
          available.length > 0 ? available.map(id => JSON.stringify(id)).join(', ') : '(none)'
        }`,
    )
  }

  /**
   * todo, caching of renderer for each block?
   * maybe do per/type?
   * also allowing people to switch between renderers would be good
   */

  const possibleRenderers = Object.values(registry)
    .filter(renderer => renderer.canRender?.({block, context}))

  const firstPriority = possibleRenderers.sort((a, b) =>
    (b.priority?.({block, context}) || 0) - (a.priority?.({block, context}) || 0))[0]

  return firstPriority ?? registry.default
}
