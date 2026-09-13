var e=`import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { blockRenderersFacet } from '@/extensions/core.js'
import { defineFacet } from '@/facets/facet.js'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'

// Demonstrates defining a brand-new facet inside an extension block,
// contributing to it from the same block, and registering a
// property-keyed renderer ('renderer: kudos-banner') that delegates to
// DefaultBlockRenderer with a wrapping ContentRenderer.
//
// Other extension blocks can import this same facet by id (a separate
// block can do  defineFacet({ id: 'user.kudos' })  and the FacetRuntime
// will merge contributions across both definitions because it keys by
// id).

interface KudosContribution {
  from: string
  message: string
}

const kudosFacet = defineFacet<KudosContribution>({
  id: 'user.kudos',
  combine: (values) => [...values],
  empty: () => [],
})

const KudosBannerContent: BlockRenderer = ({ block }: BlockRendererProps) => (
  <div>
    <em>{block.peek()?.content}</em>
    <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
      Kudos facet defined. (Other extensions can contribute to user.kudos.)
    </div>
  </div>
)

const KudosBannerRenderer: BlockRenderer = (props: BlockRendererProps) =>
  <DefaultBlockRenderer {...props} ContentRenderer={KudosBannerContent} />

export default [
  kudosFacet.of({ from: 'self', message: 'Hello from the defining block' }),
  blockRenderersFacet.of({
    id: 'kudos-banner',
    renderer: KudosBannerRenderer,
  }),
]
`;export{e as default};
//# sourceMappingURL=kudosFacet.js.map