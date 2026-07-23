import{ChangeScope as e}from"../data/api/changeScope.js";import"../data/api/index.js";import{extensionDescriptionProp as t,extensionNameProp as n}from"../data/properties.js";import{EXTENSION_TYPE as r}from"../data/blockTypes.js";import{createChild as i}from"../data/mutators.js";var a=[{id:`hello-renderer`,name:`Hello renderer`,description:`Content-renderer variant gated by 'user:hello = true'.`,source:`import { ChangeScope, seedProperty } from '@/data/api/index.js'
import { definitionSeedsFacet } from '@/data/facets.js'
import { blockContentRendererFacet } from '@/extensions/blockInteraction.js'
import { extensionPropertySeedKey } from '@/extensions/dynamicExtensionSeeds.js'
import { defineVariant } from '@/facets/variantFacet.js'

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

const HelloContent = ({ block }) => (
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
`},{id:`fold-all-action`,name:`Fold all`,description:`Action that folds/unfolds every block in the current view (Cmd+Shift+F).`,source:`import { ChangeScope } from '@/data/api/index.js'
import { isCollapsedProp, topLevelBlockIdProp } from '@/data/properties.js'
import { actionsFacet } from '@/extensions/core.js'
import { ActionContextTypes } from '@/shortcuts/types.js'

// Toggle collapse on every visible descendant of the top-level block.
// Demonstrates a single action contribution with a default keybinding.
//
// NORMAL_MODE handlers receive the panel's ui-state block (panel-bound)
// directly as uiStateBlock, so the per-panel topLevelBlockId is reachable
// without walking into ui-state/panels.
//
// Note on key syntax: this app uses tinykeys. Use '$mod' for the
// platform-primary modifier (Cmd on macOS, Ctrl elsewhere); spell
// other modifiers as 'Control', 'Alt', 'Shift'.
export default actionsFacet.of({
  id: 'user.fold-all',
  description: 'Fold/unfold every block in the current view',
  context: ActionContextTypes.NORMAL_MODE,
  // $mod+Shift+u — $mod+Shift+f is taken by Find-and-replace (global), so
  // pressing it would fire both. Pick a free chord for the demo.
  defaultBinding: { keys: '$mod+Shift+u' },
  handler: async ({ uiStateBlock }) => {
    const topLevelId = uiStateBlock.peekProperty(topLevelBlockIdProp)
    if (!topLevelId) return

    const repo = uiStateBlock.repo
    // repo.query.subtree hydrates the cache for every visited row, so per-block
    // peekProperty reads below are sync. The root is included in the subtree
    // and filtered out at the consumer boundary so the subtree query stays
    // includeRoot=true (the only shape we keep going forward).
    const subtreeWithRoot = await repo.query.subtree({id: topLevelId, hidePropertyChildren: true}).load()
    const subtree = subtreeWithRoot.filter(d => d.id !== topLevelId)
    // If anything is uncollapsed, collapse all; otherwise expand all.
    const anyExpanded = subtree.some(
      data => repo.block(data.id).peekProperty(isCollapsedProp) !== true,
    )
    await repo.tx(async tx => {
      for (const data of subtree) {
        await tx.setProperty(data.id, isCollapsedProp, anyExpanded)
      }
    }, { scope: ChangeScope.BlockDefault, description: 'fold all' })
  },
})
`},{id:`emoji-react`,name:`Emoji reactions`,description:`Multi-facet plugin: content decorator + click handler + keyboard action for adding emoji reactions to blocks.`,source:`import { ChangeScope, seedProperty } from '@/data/api/index.js'
import { definitionSeedsFacet } from '@/data/facets.js'
import {
  blockClickHandlersFacet,
  blockContentDecoratorsFacet,
  isSelectionClick,
} from '@/extensions/blockInteraction.js'
import { actionsFacet } from '@/extensions/core.js'
import { extensionPropertySeedKey } from '@/extensions/dynamicExtensionSeeds.js'
import { ActionContextTypes } from '@/shortcuts/types.js'

// Multi-facet plugin: an action, a click handler, and a content
// decorator that layers a reactions row (stored under property
// 'user:reactions') below whatever the block already renders —
// markdown, video player, edit-mode CodeMirror, or another custom
// renderer. Decorators stack on top of the chosen content renderer,
// so a video block with reactions shows both, and a block with a
// custom 'renderer: hello-renderer' property still gets its reactions
// row.

const reactionsProp = seedProperty({
  seedKey: extensionPropertySeedKey('reactions'),
  revision: 1,
  name: 'user:reactions',
  preset: 'string-list',
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

const EMOJI_OPTIONS = ['🔥', '👍', '🎉', '❤️']

const ReactionsRow = ({ reactions }) => (
  <div style={{ display: 'flex', gap: 4, fontSize: 14, marginTop: 4 }}>
    {reactions.map((emoji, i) => <span key={i}>{emoji}</span>)}
  </div>
)

const cycleReaction = async (block) => {
  const current = block.peekProperty(reactionsProp) ?? []
  const nextEmoji = EMOJI_OPTIONS[current.length % EMOJI_OPTIONS.length]
  await block.set(reactionsProp, [...current, nextEmoji])
}

export default [
  // Register the schema so the codec/editor lookups know about this
  // property and describeRuntime can list it.
  definitionSeedsFacet.of(reactionsProp),

  // Click on a block while holding Alt to add a reaction.
  blockClickHandlersFacet.of((ctx) => (event) => {
    if (!event.altKey) return
    if (isSelectionClick(event)) return
    event.preventDefault()
    event.stopPropagation()
    void cycleReaction(ctx.block)
  }),

  // Same operation as a keyboard action.
  actionsFacet.of({
    id: 'user.add-reaction',
    description: 'Add a reaction emoji to the focused block',
    context: ActionContextTypes.NORMAL_MODE,
    // $mod+Shift+e — $mod+Shift+r collides with SRS "Open review"
    // (Control+Shift+r) on Linux/Windows, where $mod is Ctrl. Use a free chord.
    defaultBinding: { keys: '$mod+Shift+e' },
    handler: async ({ block }) => cycleReaction(block),
  }),

  blockContentDecoratorsFacet.of((ctx) => {
    const reactions = ctx.block.peekProperty(reactionsProp)
    if (!Array.isArray(reactions) || reactions.length === 0) return null

    return (Inner) => {
      const Decorated = (props) => (
        <div>
          <Inner {...props} />
          <ReactionsRow reactions={reactions} />
        </div>
      )
      return Decorated
    }
  }),
]
`},{id:`kudos-facet`,name:`Kudos facet`,description:`Defines a brand-new facet and registers a property-keyed 'kudos-banner' renderer that other extensions can contribute to.`,source:`import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { blockRenderersFacet } from '@/extensions/core.js'
import { defineFacet } from '@/facets/facet.js'

// Demonstrates defining a brand-new facet inside an extension block,
// contributing to it from the same block, and registering a
// property-keyed renderer ('renderer: kudos-banner') that delegates to
// DefaultBlockRenderer with a wrapping ContentRenderer.
//
// Other extension blocks can import this same facet by id (a separate
// block can do  defineFacet({ id: 'user.kudos' })  and the FacetRuntime
// will merge contributions across both definitions because it keys by
// id).

const kudosFacet = defineFacet({
  id: 'user.kudos',
  combine: (values) => [...values],
  empty: () => [],
})

const KudosBannerContent = ({ block }) => (
  <div>
    <em>{block.peek()?.content}</em>
    <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
      Kudos facet defined. (Other extensions can contribute to user.kudos.)
    </div>
  </div>
)

const KudosBannerRenderer = (props) =>
  <DefaultBlockRenderer {...props} ContentRenderer={KudosBannerContent} />

export default [
  kudosFacet.of({ from: 'self', message: 'Hello from the defining block' }),
  blockRenderersFacet.of({
    id: 'kudos-banner',
    renderer: KudosBannerRenderer,
  }),
]
`},{id:`split-layout`,name:`Split layout`,description:`Block-layout variant for blocks tagged 'user:layout = split' — places content and children side by side.`,source:`import { ChangeScope, seedProperty } from '@/data/api/index.js'
import { definitionSeedsFacet } from '@/data/facets.js'
import { blockLayoutFacet } from '@/extensions/blockInteraction.js'
import { extensionPropertySeedKey } from '@/extensions/dynamicExtensionSeeds.js'
import { defineVariant } from '@/facets/variantFacet.js'

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

const SplitLayout = ({ Content, Children, Properties, Footer }) => (
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
// blockLayoutFacet is a variant facet — contributions return
// {id, label, render} (or use defineVariant() sugar) so a future
// picker UI could enumerate them. Returning null still means "this
// variant doesn't apply here".
export default [
  // Register the schema so describeRuntime / property-editor lookups
  // know about this property.
  definitionSeedsFacet.of(layoutProp),
  blockLayoutFacet.of((ctx) => {
    if (ctx.block.peekProperty(layoutProp) !== 'split') return null
    return defineVariant('split', 'Split (content / children)', SplitLayout)
  }),
]
`},{id:`layout-renderer-override`,name:`Layout renderer override`,description:`Overrides the app-wide 'layout' renderer id and wraps the normal panel layout with a custom frame.`,source:`import { LayoutRenderer } from '@/components/renderer/LayoutRenderer.js'
import { blockRenderersFacet } from '@/extensions/core.js'

// Replaces the app-wide renderer registered under id 'layout', so
// inserting this example wraps every panel with the custom frame
// below. Disable the row in Extensions settings (or delete the
// block) to revert to the host LayoutRenderer.

const DemoLayoutRenderer = (props) => (
  <div style={{
    display: 'grid',
    gridTemplateRows: 'auto minmax(0, 1fr)',
    height: '100%',
    minWidth: 0,
  }}>
    <div style={{
      padding: '4px 8px',
      borderBottom: '1px solid #444',
      color: '#888',
      fontSize: 12,
    }}>
      layout renderer override active
    </div>
    <LayoutRenderer {...props} />
  </div>
)

DemoLayoutRenderer.canRender = LayoutRenderer.canRender
DemoLayoutRenderer.priority = LayoutRenderer.priority

export default blockRenderersFacet.of({
  id: 'layout',
  renderer: DemoLayoutRenderer,
})
`},{id:`default-renderer-placeholder`,name:`Default renderer placeholder`,description:`Overrides the fallback 'default' renderer id so ordinary empty blocks show a muted read-mode placeholder.`,source:`import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.js'
import { blockRenderersFacet } from '@/extensions/core.js'

// Replaces the fallback renderer registered under id 'default'.
// Inserting this example immediately changes every ordinary block
// that falls through to the default renderer: empty blocks show a
// muted read-mode placeholder while edit mode, children, properties,
// bullets, and selection chrome stay unchanged. Disable the row in
// Extensions settings (or delete the block) to revert.

const PlaceholderContent = ({ block }) => {
  const content = block.peek()?.content ?? ''
  if (content.trim().length === 0) {
    return (
      <div style={{ minHeight: '1.7em', color: '#888', fontStyle: 'italic' }}>
        empty block
      </div>
    )
  }

  return <MarkdownContentRenderer block={block} />
}

const PlaceholderDefaultRenderer = (props) => (
  <DefaultBlockRenderer {...props} ContentRenderer={PlaceholderContent} />
)

export default blockRenderersFacet.of({
  id: 'default',
  renderer: PlaceholderDefaultRenderer,
})
`}],o=async o=>{let s=o.repo,c=[],l=s.snapshotTypeRegistries();for(let u of a){let a=await s.tx(async e=>{let a=await e.run(i,{parentId:o.id,content:u.source});return await s.addTypeInTx(e,a,r,{[n.name]:u.name,[t.name]:u.description},l),a},{scope:e.BlockDefault,description:`insert example extension`});c.push(s.block(a))}return c};export{a as exampleExtensions,o as insertExampleExtensionsUnder};
//# sourceMappingURL=exampleExtensions.js.map