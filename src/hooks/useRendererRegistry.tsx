import { BlockRendererProps, BlockRenderer } from '../types'
import { getBlockTypes, rendererProp } from '@/data/properties.js'
import { useData, usePropertyValue } from '@/hooks/block.js'
import type { BlockData } from '@/data/api'
import { blockRendererFacet } from '@/extensions/blockInteraction.js'
import { refreshAppRuntime } from '@/facets/runtimeEvents.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { useRepo } from '@/context/repo.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'

export const refreshRendererRegistry = async () => {
  refreshAppRuntime()
}

const NO_TYPES: readonly string[] = []

/**
 * Total, by contract. Resolution runs for every block during its loading
 * window, ABOVE `BlockComponent`'s ErrorBoundary, so a malformed `types`
 * value must not throw here — `getBlockTypes` raises a CodecError on a
 * non-array or a non-string element, which the cache boundary does not
 * validate. Every per-type gate used to hand-roll its own total read for
 * this reason; they read `ctx.types` now, so the totality lives here.
 */
const typesOf = (data: BlockData | undefined): readonly string[] => {
  if (!data) return NO_TYPES
  try {
    return getBlockTypes(data)
  } catch {
    return NO_TYPES
  }
}

/**
 * Pick the renderer for a block: the one the block's `renderer` property
 * names, else the strongest registration that claims it (see
 * `blockRendererFacet`), else the plain default.
 *
 * `useData` is a whole-block subscription, and the snapshot is threaded
 * into the resolution rather than peeked out of `block` inside it. Most
 * gates key off `types`, but not all — the video player recognizes a URL
 * in the CONTENT — so the resolution has to re-run on any change to the
 * block, and passing the snapshot in is what makes that dependency
 * structural instead of something the memoizer has to be told to ignore.
 */
export const useRenderer = ({block, context}: BlockRendererProps): BlockRenderer => {
  const data = useData(block)
  const [rendererKey] = usePropertyValue(block, rendererProp)
  const repo = useRepo()
  const resolve = useAppRuntime().read(blockRendererFacet)

  const selection = resolve({block, repo, types: typesOf(data), blockContext: context})
  return (selection.byId(rendererKey) ?? selection.last)?.render ?? DefaultBlockRenderer
}
