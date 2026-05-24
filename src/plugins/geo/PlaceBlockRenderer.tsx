/** Renderer for individual Place blocks — shows a tight mini-map of
 *  the place's own pin above the standard outline body, so opening
 *  e.g. "Dandelion Chocolate" lands on a visual context, not just
 *  metadata + backlinks.
 *
 *  Implementation note: the underlying `placesUnderBlockQuery` already
 *  handles "root is a Place" — `SUBTREE_SQL` includes the root row, and
 *  the query then pins it from its own lat/lng. No special path. */

import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'
import { PLACE_TYPE } from './blockTypes'
import { MapView } from './MapView'

const PlaceContentRenderer: BlockRenderer = (props: BlockRendererProps) => {
  const {block} = props
  return (
    <div className="flex w-full flex-col gap-3">
      <MapView
        rootBlockId={block.id}
        className="h-56 w-full overflow-hidden rounded-md border"
        defaultZoom={15}
      />
      <MarkdownContentRenderer {...props} />
    </div>
  )
}
PlaceContentRenderer.displayName = 'PlaceContentRenderer'

export const PlaceBlockRenderer: BlockRenderer = Object.assign(
  (props: BlockRendererProps) => (
    <DefaultBlockRenderer
      {...props}
      ContentRenderer={PlaceContentRenderer}
    />
  ),
  {
    canRender: ({block}: BlockRendererProps): boolean => {
      const data = block.peek()
      if (!data) return false
      const types = data.properties.types
      return Array.isArray(types) && types.includes(PLACE_TYPE)
    },
    // Higher than LocationsPageBlockRenderer (100) is unnecessary —
    // Place blocks don't carry LOCATIONS_PAGE_TYPE — but matching it
    // keeps both place-renderer priorities on the same scale, so a
    // future general-purpose page renderer at the default priority
    // won't shadow either.
    priority: () => 100,
  },
)
PlaceBlockRenderer.displayName = 'PlaceBlockRenderer'
