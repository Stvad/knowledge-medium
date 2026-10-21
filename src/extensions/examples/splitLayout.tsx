import { ChangeScope, seedProperty } from '@/data/api/index.js'
import { definitionSeedsFacet } from '@/data/facets.js'
import { blockLayoutFacet, type BlockLayout, type BlockLayoutSlots } from '@/extensions/blockInteraction.js'
import { extensionPropertySeedKey } from '@/extensions/dynamicExtensionSeeds.js'

// blockLayoutFacet contributions arrange the four slots (Content,
// Properties, Children, Footer) inside a block's body. Each slot is
// already wrapped in its own ErrorBoundary + interaction provider
// boundary, so swapping the layout doesn't change shortcut-surface
// scoping or accidentally nest descendant blocks inside the parent's
// content surface.
//
// Compose with content renderers freely: a block can have a custom
// 'renderer: hello-renderer' AND a custom layout — the layout just
// arranges the slots; the slots' insides are still resolved through
// the rest of the registry.

const layoutProp = seedProperty({
  seedKey: extensionPropertySeedKey('layout'),
  revision: 1,
  name: 'user:layout',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

const SplitLayout: BlockLayout = ({ Content, Children, Properties, Footer }: BlockLayoutSlots) => (
  <div>
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Content />
        {Properties && <Properties />}
      </div>
      <div style={{ flex: 1, minWidth: 0, borderLeft: '1px solid #444', paddingLeft: 12 }}>
        <Children />
      </div>
    </div>
    <Footer />
  </div>
)

// Apply side-by-side layout to any block whose 'user:layout' property
// is 'split'. Returning null for everything else lets ordinary blocks
// fall through to the default vertical layout.
//
// blockLayoutFacet is a variant facet — a contribution is
// {id, label, resolve} (or {id, label, render} / defineVariant() sugar
// when it applies everywhere), so a picker UI can enumerate what is
// installed without a block in hand. resolve returning null still means
// "this variant doesn't apply here".
export default [
  // Register the schema so describeRuntime / property-editor lookups
  // know about this property.
  definitionSeedsFacet.of(layoutProp),
  blockLayoutFacet.of({
    id: 'split',
    label: 'Split (content / children)',
    resolve: (ctx) =>
      ctx.block.peekProperty(layoutProp) === 'split' ? { render: SplitLayout } : null,
  }),
]
