/** Renderer for the Locations page — shows the map of all Place
 *  blocks in the workspace above the standard outline body so the
 *  user lands on a visual index, not a flat list. */

import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'
import { LOCATIONS_PAGE_TYPE } from './blockTypes'
import { MapView } from './MapView'

const LocationsPageContentRenderer: BlockRenderer = (props: BlockRendererProps) => {
  const {block} = props
  return (
    <div className="flex w-full flex-col gap-3">
      <MarkdownContentRenderer {...props} />
      <MapView rootBlockId={block.id} />
    </div>
  )
}
LocationsPageContentRenderer.displayName = 'LocationsPageContentRenderer'

export const LocationsPageBlockRenderer: BlockRenderer = Object.assign(
  (props: BlockRendererProps) => (
    <DefaultBlockRenderer
      {...props}
      ContentRenderer={LocationsPageContentRenderer}
    />
  ),
  {
    canRender: ({block}: BlockRendererProps): boolean => {
      const data = block.peek()
      if (!data) return false
      const types = data.properties.types
      return Array.isArray(types) && types.includes(LOCATIONS_PAGE_TYPE)
    },
    priority: () => 100,
  },
)
LocationsPageBlockRenderer.displayName = 'LocationsPageBlockRenderer'
