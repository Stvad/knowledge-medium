import { BlockRendererProps } from '../types'
import { rendererProp } from '@/data/properties.js'
import { usePropertyValue, useData } from '@/hooks/block.js'
import { usePropertySchemas } from '@/hooks/propertySchemas.js'
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

  // A `canRender` may recognize the block through its property DEFINITIONS (a
  // property field row), and a definition can register after the block
  // mounted; re-choosing on a registry swap is what picks that up.
  usePropertySchemas()

  const [rendererKey] = usePropertyValue(block, rendererProp)
  const runtime = useAppRuntime()
  const registry = runtime.read(blockRenderersFacet)

  if (rendererKey && registry[rendererKey]) {
    return registry[rendererKey]
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
