import { BlockRendererProps } from '../types'
import { rendererProp } from '@/data/properties.js'
import { usePropertyValue, useData } from '@/hooks/block.js'
import { useCallback, useContext, useSyncExternalStore } from 'react'
import { PropertyRowListingContext } from '@/context/propertyDisplay.js'
import type { Repo } from '@/data/repo'
import { blockRenderersFacet } from '@/extensions/core.js'
import { refreshAppRuntime } from '@/facets/runtimeEvents.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'

export { defaultRegistry } from '@/extensions/defaultRenderers.js'

export const refreshRendererRegistry = async () => {
  refreshAppRuntime()
}

const NO_SUBSCRIPTION = () => () => {}
const NO_SNAPSHOT = () => null

/** Re-render on a property-registry swap while `active`; inactive, it neither
 *  subscribes nor re-renders. */
const usePropertyRegistryIn = (repo: Repo, active: boolean): void => {
  const subscribe = useCallback((cb: () => void) => repo.onPropertySchemasChange(cb), [repo])
  const snapshot = useCallback(() => repo.propertySchemas, [repo])
  useSyncExternalStore(active ? subscribe : NO_SUBSCRIPTION, active ? snapshot : NO_SNAPSHOT)
}

export const useRenderer = ({block, context}: BlockRendererProps) => {
  'use no memo'
  useData(block)
  /**
   * The above is a cludge to make this re-render on useData changes, compiler would over-memoize this otherwise
   * Ideally we make the dependency clear and structural tho
   */

  // A property-row renderer recognizes a field row through its DEFINITION, which
  // can register after the row mounted; re-choose on a registry swap — only in
  // a listing that shows property rows, so every other block ignores swaps.
  usePropertyRegistryIn(block.repo, useContext(PropertyRowListingContext) !== null)

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
