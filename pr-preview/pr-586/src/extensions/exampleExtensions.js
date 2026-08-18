import{ChangeScope as e}from"../data/api/changeScope.js";import"../data/api/index.js";import{extensionDescriptionProp as t,extensionNameProp as n}from"../data/properties.js";import{EXTENSION_TYPE as r}from"../data/blockTypes.js";import{createChild as i}from"../data/mutators.js";var a=[{id:`hello-renderer`,name:`Hello renderer`,description:`Content-renderer variant gated by 'user:hello = true'.`,source:`import { ChangeScope, seedProperty } from '@/data/api/index.js'
import { definitionSeedsFacet } from '@/data/facets.js'
import { blockContentRendererFacet } from '@/extensions/blockInteraction.js'
import { extensionPropertySeedKey } from '@/extensions/dynamicExtensionSeeds.js'

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
  blockContentRendererFacet.of({
    id: 'user.hello',
    label: 'Hello',
    resolve: (ctx) =>
      ctx.block.peekProperty(helloProp) ? { render: HelloContent } : null,
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
import { blockRendererFacet } from '@/extensions/blockInteraction.js'
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
  blockRendererFacet.of({
    id: 'kudos-banner',
    label: 'Kudos banner',
    // No resolve: this one is only ever reached through the block's
    // 'renderer' property, so it must not claim blocks on its own.
    render: KudosBannerRenderer,
    claims: false,
  }),
]
`},{id:`split-layout`,name:`Split layout`,description:`Block-layout variant for blocks tagged 'user:layout = split' — places content and children side by side.`,source:`import { ChangeScope, seedProperty } from '@/data/api/index.js'
import { definitionSeedsFacet } from '@/data/facets.js'
import { blockLayoutFacet } from '@/extensions/blockInteraction.js'
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
`},{id:`layout-renderer-override`,name:`Layout renderer override`,description:`Overrides the app-wide 'layout' renderer id and wraps the normal panel layout with a custom frame.`,source:`import { LayoutRenderer, layoutRendererRegistration } from '@/components/renderer/LayoutRenderer.js'
import { blockRendererFacet } from '@/extensions/blockInteraction.js'

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

// Same id as the host's layout renderer, at the precedence the host holds:
// among registrations sharing an id only the strongest survives, and an
// equal precedence goes to whoever registered later (extensions register
// after core). Reusing the host's resolve keeps the gate identical too —
// only the component differs.
export default blockRendererFacet.of({
  id: 'layout',
  label: 'Panel layout (demo)',
  resolve: (ctx) =>
    layoutRendererRegistration.resolve?.(ctx) ? { render: DemoLayoutRenderer } : null,
}, { precedence: 20 })
`},{id:`default-renderer-placeholder`,name:`Default renderer placeholder`,description:`Overrides the fallback 'default' renderer id so ordinary empty blocks show a muted read-mode placeholder.`,source:`import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.js'
import { blockRendererFacet } from '@/extensions/blockInteraction.js'

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

// No precedence: the host's 'default' sits at the implicit 0 and an equal
// precedence goes to whoever registered later, so this replaces it. Raising
// it would ALSO lift the default renderer above the ladder above it — the
// not-yet-loaded placeholder at 1, the extension editor at 5 — which is a
// different change than replacing the fallback.
export default blockRendererFacet.of({
  id: 'default',
  label: 'Block',
  render: PlaceholderDefaultRenderer,
})
`}],o=async o=>{let s=o.repo,c=[],l=s.snapshotTypeRegistries();for(let u of a){let a=await s.tx(async e=>{let a=await e.run(i,{parentId:o.id,content:u.source});return await s.addTypeInTx(e,a,r,{[n.name]:u.name,[t.name]:u.description},l),a},{scope:e.BlockDefault,description:`insert example extension`});c.push(s.block(a))}return c};export{a as exampleExtensions,o as insertExampleExtensionsUnder};
//# sourceMappingURL=exampleExtensions.js.map