/** Block content decorator that wraps Locations pages and Place blocks
 *  with their respective MapView. Replaces the earlier
 *  `blockRenderersFacet`-based per-type renderer overrides: a decorator
 *  composes with the default content renderer rather than displacing
 *  it, so any future renderer the user picks for these blocks still
 *  works and the map just rides on top.
 *
 *  Cached per inner renderer (and per kind) so React keeps a stable
 *  component identity across re-renders — required by
 *  `blockContentDecoratorsFacet` to avoid unmounting the inner subtree
 *  on every parent render. */

import type { Block } from '@/data/block.js'
import {
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { LOCATIONS_PAGE_TYPE, PLACE_TYPE } from './blockTypes'
import { MapView } from './MapView'

type GeoMapKind = 'place' | 'locations'

interface GeoMapDecoratorProps {
  block: Block
  Inner: BlockRenderer
  kind: GeoMapKind
}

const GeoMapDecorator = ({block, Inner, kind}: GeoMapDecoratorProps) => {
  if (kind === 'place') {
    return (
      <div className="flex w-full flex-col gap-3">
        <MapView
          rootBlockId={block.id}
          className="h-56 w-full overflow-hidden rounded-md border"
          defaultZoom={15}
        />
        <Inner block={block}/>
      </div>
    )
  }
  return (
    <div className="flex w-full flex-col gap-3">
      <Inner block={block}/>
      <MapView rootBlockId={block.id}/>
    </div>
  )
}

const cache = new WeakMap<BlockRenderer, Partial<Record<GeoMapKind, BlockRenderer>>>()

const decorateWith = (kind: GeoMapKind): BlockContentDecorator => inner => {
  let entry = cache.get(inner)
  if (!entry) {
    entry = {}
    cache.set(inner, entry)
  }
  const existing = entry[kind]
  if (existing) return existing
  const Decorated: BlockRenderer = ({block}) => (
    <GeoMapDecorator block={block} Inner={inner} kind={kind}/>
  )
  Decorated.displayName = `WithGeoMap(${kind})`
  entry[kind] = Decorated
  return Decorated
}

export const geoContentDecoratorContribution: BlockContentDecoratorContribution = ctx => {
  if (ctx.types.includes(PLACE_TYPE)) return decorateWith('place')
  if (ctx.types.includes(LOCATIONS_PAGE_TYPE)) return decorateWith('locations')
  return null
}
