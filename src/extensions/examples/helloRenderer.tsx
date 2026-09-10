import { ChangeScope, seedProperty } from '@/data/api/index.js'
import { definitionSeedsFacet } from '@/data/facets.js'
import { blockContentRendererFacet } from '@/extensions/blockInteraction.js'
import { extensionPropertySeedKey } from '@/extensions/dynamicExtensionSeeds.js'
import { defineVariant } from '@/facets/variantFacet.js'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'

// Variant on blockContentRendererFacet: contributes an alternative
// content renderer for blocks tagged 'user:hello = true'. Returning
// null for everything else lets ordinary blocks fall through to the
// host's primary renderer. The bullet, children, properties, and
// edit affordances keep working because the variant only swaps the
// content area inside DefaultBlockRenderer — the rest of the block
// chrome is untouched.

const helloProp = seedProperty({
  seedKey: extensionPropertySeedKey('hello'),
  revision: 1,
  name: 'user:hello',
  preset: 'boolean',
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

const HelloContent: BlockRenderer = ({ block }: BlockRendererProps) => (
  <div style={{ padding: 8, border: '1px dashed #888', borderRadius: 4 }}>
    <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
      hello-renderer custom content area:
    </div>
    <em>{block.peek()?.content}</em>
  </div>
)

export default [
  // Register the schema so the value-preset / property-editor lookups
  // can find this prop, and describeRuntime can list it.
  definitionSeedsFacet.of(helloProp),
  blockContentRendererFacet.of((ctx) => {
    if (!ctx.block.peekProperty(helloProp)) return null
    return defineVariant('user.hello', 'Hello', HelloContent)
  }),
]
