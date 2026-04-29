import { BlockRendererProps } from '../types'
import { rendererProp } from '@/data/properties.ts'
import { usePropertyValue, useData } from '@/hooks/block.ts'
import { blockRenderersFacet } from '@/extensions/core.ts'
import { refreshAppRuntime } from '@/extensions/runtimeEvents.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'

export { defaultRegistry } from '@/extensions/defaultRenderers.tsx'

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
